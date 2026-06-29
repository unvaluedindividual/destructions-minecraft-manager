let activeFolder = null; let activeConfig = null; let systemMaxRam = 2; let isSyncing = false;
const serverLogs = {}; let hasUnsavedChanges = false;
let currentPath = ""; let pathHistory = [""]; let historyIndex = 0; let editingFilePath = "";
let statsInterval = null;
let cpuData = Array(30).fill(0);
let ramData = Array(30).fill(0);
let updateCheckTriggeredThisSession = false;
let selectedContextItem = null;
let bulkSelection = [];
let moveSourcePaths = [];

const viewList = document.getElementById('viewServerList');
const viewDashboard = document.getElementById('viewDashboard');
const serversContainer = document.getElementById('serversContainer');
const terminalOutput = document.getElementById('terminalOutput');

const minBtn = document.getElementById('minBtn');
if (minBtn) minBtn.addEventListener('click', () => window.electronAPI.minimizeApp());

const closeBtn = document.getElementById('closeBtn');
if (closeBtn) closeBtn.addEventListener('click', () => window.electronAPI.closeApp());

function customAlert(message) {
    return new Promise(resolve => {
        document.getElementById('alertModalText').innerText = message;
        const modal = document.getElementById('alertModal');
        modal.classList.add('active');
        const btn = document.getElementById('alertOkBtn');
        btn.onclick = () => { modal.classList.remove('active'); resolve(); };
    });
}

function customPrompt(message, defaultValue = "") {
    return new Promise(resolve => {
        document.getElementById('promptModalText').innerText = message;
        const input = document.getElementById('promptModalInput');
        input.value = defaultValue;
        const modal = document.getElementById('promptModal');
        modal.classList.add('active');
        input.focus();

        const cancelBtn = document.getElementById('promptCancelBtn');
        const confirmBtn = document.getElementById('promptConfirmBtn');

        const cleanup = () => {
            modal.classList.remove('active');
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
            input.onkeydown = null;
        };

        cancelBtn.onclick = () => { cleanup(); resolve(null); };
        confirmBtn.onclick = () => { cleanup(); resolve(input.value); };
        input.onkeydown = (e) => {
            if (e.key === 'Enter') { cleanup(); resolve(input.value); }
            if (e.key === 'Escape') { cleanup(); resolve(null); }
        };
    });
}

let confirmCallback = null;
function requestConfirmation(message, callback) {
    const textEl = document.getElementById('confirmModalText');
    const modalEl = document.getElementById('confirmModal');
    if (textEl && modalEl) {
        textEl.innerText = message;
        modalEl.classList.add('active');
        confirmCallback = callback;
    }
}

const confirmActionBtn = document.getElementById('confirmActionBtn');
if (confirmActionBtn) {
    confirmActionBtn.addEventListener('click', () => {
        if (confirmCallback) confirmCallback();
        document.getElementById('confirmModal').classList.remove('active');
        confirmCallback = null;
    });
}

let unsavedProceedCallback = null;
function requestUnsavedConfirmation(callback) {
    const modalEl = document.getElementById('unsavedModal');
    if (modalEl) {
        modalEl.classList.add('active');
        unsavedProceedCallback = callback;
    }
}
const unsavedProceedBtn = document.getElementById('unsavedProceedBtn');
const unsavedCancelBtn = document.getElementById('unsavedCancelBtn');
if(unsavedProceedBtn) unsavedProceedBtn.onclick = () => { document.getElementById('unsavedModal').classList.remove('active'); if(unsavedProceedCallback) unsavedProceedCallback(); unsavedProceedCallback = null; };
if(unsavedCancelBtn) unsavedCancelBtn.onclick = () => { document.getElementById('unsavedModal').classList.remove('active'); unsavedProceedCallback = null; };

function copyIdToClipboard(event, element, textId) {
    event.stopPropagation();
    navigator.clipboard.writeText(textId);
    const toast = document.createElement('span');
    toast.className = 'copy-toast';
    toast.innerText = 'Copied!';
    element.appendChild(toast);
    setTimeout(() => toast.remove(), 800);
}

const globalKillBtns = document.querySelectorAll('.global-kill-btn');
globalKillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        requestConfirmation("Are you sure you want to Kill All Java processes? This will hard-crash ALL running servers.", () => {
            requestConfirmation("Are you ABSOLUTELY sure? This cannot be undone and may corrupt actively saving data.", async () => {
                await window.electronAPI.killAllJava();
                await customAlert("All Java processes have been terminated.");
                syncList();
            });
        });
    });
});

let draggedItem = null;
async function syncList() {
    if (isSyncing) return; isSyncing = true;
    try {
        const items = await window.electronAPI.getServers();
        if (!serversContainer) return;
        serversContainer.innerHTML = "";
        const emptyState = document.getElementById('emptyState');
        if (emptyState) {
            emptyState.style.display = items.length === 0 ? 'block' : 'none';
        }
        
        items.forEach(srv => {
            const card = document.createElement('div'); card.className = 'server-card'; card.draggable = true; card.dataset.folder = srv.folder;
            let statusDot = srv.status === 'online' ? '<span class="status-dot status-online"></span>' : '<span class="status-dot status-offline"></span>';
            let actionBtn = srv.status === 'online' 
                ? `<button class="btn-base btn-warn list-stop-btn">Stop</button><button class="btn-base btn-kill list-kill-btn" style="display:none;">Kill</button>`
                : `<button class="btn-base btn-open list-start-btn">Start</button>`;
            
            let statusText = srv.status === 'online' ? 'Online' : 'Offline';
            card.innerHTML = `
                <div class="drag-handle">⋮</div>
                <div style="flex: 1;" class="card-clickable">
                    <h3 style="margin:0 0 4px 0; font-size:1.05rem;">${srv.name}</h3>
                    <span style="color:var(--text-muted); font-size:0.85rem;">${statusDot} ${statusText} &nbsp;•&nbsp; ${srv.folder} &nbsp;•&nbsp; ${srv.type} ${srv.version} &nbsp;•&nbsp; ${srv.ram}GB</span>
                </div>
                <div style="display:flex; gap:10px; align-items: center;">${actionBtn}<button class="btn-base btn-kill list-delete-btn">Delete</button></div>
            `;
            
            card.addEventListener('dragstart', function(e) { 
                draggedItem = this; 
                e.dataTransfer.effectAllowed = 'move';
                setTimeout(() => this.classList.add('dragging'), 0); 
            });
            card.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                return false;
            });
            card.addEventListener('dragenter', function(e) { this.classList.add('drag-over'); });
            card.addEventListener('dragleave', function(e) { this.classList.remove('drag-over'); });
            card.addEventListener('drop', function(e) {
                e.stopPropagation();
                if (draggedItem !== this) {
                    let allCards = Array.from(serversContainer.children);
                    let draggedIdx = allCards.indexOf(draggedItem);
                    let targetIdx = allCards.indexOf(this);
                    if (draggedIdx < targetIdx) {
                        this.parentNode.insertBefore(draggedItem, this.nextSibling);
                    } else {
                        this.parentNode.insertBefore(draggedItem, this);
                    }
                }
                return false;
            });
            card.addEventListener('dragend', function() { 
                this.classList.remove('dragging'); 
                document.querySelectorAll('.server-card').forEach(c => c.classList.remove('drag-over'));
                window.electronAPI.reorderServers(Array.from(serversContainer.children).map(c => c.dataset.folder)); 
            });

            card.querySelector('.card-clickable').onclick = async () => {
                if (srv.autoUpdate === 'yes' && srv.status === 'offline' && !updateCheckTriggeredThisSession) {
                    const manifest = await window.electronAPI.checkManifestUpdates();
                    if (manifest && manifest.latest) {
                        requestConfirmation(`A new stable Minecraft version ${manifest.latest.release} is available. Do you want to check updates?`, () => { document.getElementById('changeJarModal').classList.add('active'); enterWorkspace(srv.folder, srv); });
                        const confirmModal = document.getElementById('confirmModal');
                        if (confirmModal) {
                            const btn = confirmModal.querySelector('.btn-base');
                            if (btn) {
                                btn.onclick = () => { 
                                    confirmModal.classList.remove('active'); 
                                    enterWorkspace(srv.folder, srv); 
                                };
                            }
                        }
                        updateCheckTriggeredThisSession = true;
                        return;
                    }
                } 
                enterWorkspace(srv.folder, srv);
            };
            if (srv.status === 'online') {
                const stopBtn = card.querySelector('.list-stop-btn'); const killBtn = card.querySelector('.list-kill-btn');
                if (stopBtn) stopBtn.onclick = (e) => { e.stopPropagation(); window.electronAPI.stopServer(srv.folder); stopBtn.style.display = 'none'; if (killBtn) killBtn.style.display = 'block'; };
                if (killBtn) killBtn.onclick = (e) => { e.stopPropagation(); window.electronAPI.killServer(srv.folder); };
            } else {
                const startBtn = card.querySelector('.list-start-btn');
                if (startBtn) startBtn.onclick = (e) => { e.stopPropagation(); window.electronAPI.startServer(srv.folder); syncList(); };
            }
            const deleteBtn = card.querySelector('.list-delete-btn');
            if (deleteBtn) {
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    requestConfirmation(`Deleting ${srv.name} is permanent. Proceed?`, async () => {
                        const res = await window.electronAPI.deleteServer(srv.folder);
                        if (res && res.success === false) {
                            if (res.message === "locked") requestConfirmation("Java is locking this folder. Force close ALL background Java processes to delete?", async () => { await window.electronAPI.killAllJava(); await window.electronAPI.deleteServer(srv.folder); syncList(); });
                            else customAlert(res.message);
                        } else syncList();
                    });
                };
            }
            serversContainer.appendChild(card);
        });
    } catch(err) {
        console.error(err);
    } finally {
        isSyncing = false;
    }
}

async function enterWorkspace(folder, config) {
    activeFolder = folder; activeConfig = config;
    const titleEl = document.getElementById('activeServerTitle');
    if (titleEl) titleEl.innerText = config.name;
    const nodeDisplay = document.getElementById('activeNodeDisplayHeader');
    if (nodeDisplay) nodeDisplay.innerText = folder;
    if (viewList) viewList.classList.remove('active');
    if (viewDashboard) viewDashboard.classList.add('active');
    if (!serverLogs[folder]) serverLogs[folder] = `connected to ${config.name}\n`;
    if (terminalOutput) { terminalOutput.innerText = serverLogs[folder]; terminalOutput.scrollTop = terminalOutput.scrollHeight; }
    const updatedServers = await window.electronAPI.getServers();
    const updatedConfig = updatedServers.find(s => s.folder === folder);
    if(updatedConfig) { activeConfig.status = updatedConfig.status; activeConfig.port = updatedConfig.port || activeConfig.port; }
    updateWorkspaceStatus(activeConfig.status, activeConfig.port);
    const nameInput = document.getElementById('setServerName'); const descInput = document.getElementById('setServerDesc'); const autoUpdateInput = document.getElementById('loadAutoUpdateToggle'); const autoRestartInput = document.getElementById('loadAutoRestart'); const javaVerInput = document.getElementById('loadJavaVer'); const flagsInput = document.getElementById('loadStartupFlags');
    if (nameInput) nameInput.value = config.name; if (descInput) descInput.value = config.description || ""; if (autoUpdateInput) autoUpdateInput.checked = config.autoUpdate === 'yes'; if (autoRestartInput) autoRestartInput.checked = !!config.autoRestart; if (javaVerInput) javaVerInput.value = config.javaVersion || "Default"; if (flagsInput) flagsInput.value = config.startupFlags || "";
    switchTab('console');
}

function exitWorkspace() {
    if (hasUnsavedChanges) { requestUnsavedConfirmation(() => { hasUnsavedChanges = false; exitWorkspaceImpl(); }); } else { exitWorkspaceImpl(); }
}

function exitWorkspaceImpl() {
    activeFolder = null; activeConfig = null; currentPath = ""; pathHistory = [""]; historyIndex = 0; hasUnsavedChanges = false;
    if(statsInterval) clearInterval(statsInterval);
    if (viewDashboard) viewDashboard.classList.remove('active');
    if (viewList) viewList.classList.add('active');
    syncList();
}

function switchTab(tabId) {
    if (hasUnsavedChanges && tabId !== 'files') {
        requestUnsavedConfirmation(() => {
            hasUnsavedChanges = false;
            const editorView = document.getElementById('fileEditorView'); const browserView = document.getElementById('fileBrowserView');
            if (editorView) editorView.classList.remove('active');
            if (browserView) browserView.style.display = 'flex';
            switchTabImpl(tabId);
        });
    } else { switchTabImpl(tabId); }
}

function switchTabImpl(tabId) {
    document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    const tabItem = document.querySelector(`.tab-item[onclick="switchTab('${tabId}')"]`);
    if (tabItem) tabItem.classList.add('active');
    const tabContent = document.getElementById(`tab-${tabId}`);
    if (tabContent) tabContent.classList.add('active');
    if(statsInterval) { clearInterval(statsInterval); statsInterval = null; }
    if(tabId === 'files') { if(!hasUnsavedChanges) loadFilesCustom(); }
    if(tabId === 'backups') loadBackups();
    if(tabId === 'players') loadPlayers();
    if(tabId === 'analytics') startAnalytics();
    if(tabId === 'tasks') loadTasks();
}

async function loadPlayers() {
    const grid = document.getElementById('playersGrid');
    if (!grid) return;
    grid.innerHTML = "Loading...";
    let players = await window.electronAPI.getPlayers(activeFolder);
    grid.innerHTML = players.length === 0 ? '<div style="color:var(--text-muted); grid-column:1/-1;">No player data found yet.</div>' : '';
    const render = async (filter = "") => {
        grid.innerHTML = "";
        const ops = await window.electronAPI.readFile(activeFolder, 'ops.json').then(d => JSON.parse(d || "[]")).catch(() => []);
        const banned = await window.electronAPI.readFile(activeFolder, 'banned-players.json').then(d => JSON.parse(d || "[]")).catch(() => []);
        const whitelisted = await window.electronAPI.readFile(activeFolder, 'whitelist.json').then(d => JSON.parse(d || "[]")).catch(() => []);
        players.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())).forEach(p => {
            const isOp = ops.some(o => o.name === p.name);
            const isBanned = banned.some(b => b.name === p.name);
            const isWhitelisted = whitelisted.some(w => w.name === p.name);
            const card = document.createElement('div'); card.className = 'player-card';
            
            card.innerHTML = `
                <img class="player-head" src="https://mc-heads.net/avatar/${p.name}" onerror="this.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='">
                <div style="flex:1; display:flex; flex-direction:column; gap:4px;">
                    <div style="font-weight:600; display:flex; align-items:center; gap:8px;">
                        ${p.name}
                        <span style="width:8px; height:8px; border-radius:50%; background:${p.isOnline ? '#16a34a' : '#71717a'};"></span>
                    </div>
                    <div class="player-uuid-clickable" style="font-size:0.75rem; color:var(--text-muted);">ID: ${p.uuid}</div>
                </div>
            `;
            
            card.querySelector('.player-uuid-clickable').addEventListener('click', (e) => copyIdToClipboard(e, e.currentTarget, p.uuid));
            card.addEventListener('click', (e) => {
                if(e.target.classList.contains('player-uuid-clickable')) return;
                openPlayerModal(p, isOp, isBanned, isWhitelisted);
            });
            grid.appendChild(card);
        });
    };
    render();
    const searchEl = document.getElementById('playerSearch');
    if (searchEl) searchEl.oninput = (e) => render(e.target.value);
}

function openPlayerModal(p, isOp, isBanned, isWhitelisted) {
    const modal = document.getElementById('playerModal');
    document.getElementById('pmHead').src = `https://mc-heads.net/avatar/${p.name}`;
    document.getElementById('pmName').innerText = p.name;
    
    const btnOp = document.getElementById('pmBtnOp');
    btnOp.innerText = isOp ? "De-OP Player" : "OP Player";
    btnOp.style.background = isOp ? "#1e1b4b" : "#311042";
    btnOp.style.color = isOp ? "#818cf8" : "#d946ef";
    btnOp.onclick = () => { window.electronAPI.sendCommand(activeFolder, isOp ? `deop ${p.name}` : `op ${p.name}`); modal.classList.remove('active'); setTimeout(() => loadPlayers(), 500); };
    
    const btnBan = document.getElementById('pmBtnBan');
    btnBan.innerText = isBanned ? "Pardon Player" : "Ban Player";
    btnBan.style.background = isBanned ? "#064e3b" : "#4c0519";
    btnBan.style.color = isBanned ? "#34d399" : "#f43f5e";
    btnBan.onclick = () => { window.electronAPI.sendCommand(activeFolder, isBanned ? `pardon ${p.name}` : `ban ${p.name}`); modal.classList.remove('active'); setTimeout(() => loadPlayers(), 500); };
    
    const btnWhite = document.getElementById('pmBtnWhite');
    btnWhite.innerText = isWhitelisted ? "Un-list Player" : "Whitelist Player";
    btnWhite.style.background = isWhitelisted ? "#451a03" : "#14532d";
    btnWhite.style.color = isWhitelisted ? "#fb923c" : "#4ade80";
    btnWhite.onclick = () => { window.electronAPI.sendCommand(activeFolder, isWhitelisted ? `whitelist remove ${p.name}` : `whitelist add ${p.name}`); modal.classList.remove('active'); setTimeout(() => loadPlayers(), 500); };
    
    const btnKick = document.getElementById('pmBtnKick');
    btnKick.disabled = !p.isOnline;
    btnKick.onclick = () => { window.electronAPI.sendCommand(activeFolder, `kick ${p.name}`); modal.classList.remove('active'); setTimeout(() => loadPlayers(), 500); };
    
    modal.classList.add('active');
}

function startAnalytics() {
    const cpuCanvas = document.getElementById('cpuGraphCanvas'); const cpuCtx = cpuCanvas ? cpuCanvas.getContext('2d') : null;
    const ramCanvas = document.getElementById('ramGraphCanvas'); const ramCtx = ramCanvas ? ramCanvas.getContext('2d') : null;
    const draw = () => {
        if (!cpuCanvas || !ramCanvas || !cpuCtx || !ramCtx) return;
        [cpuCanvas, ramCanvas].forEach(c => { c.width = c.clientWidth; c.height = c.clientHeight; });
        cpuCtx.clearRect(0, 0, cpuCanvas.width, cpuCanvas.height);
        ramCtx.clearRect(0, 0, ramCanvas.width, ramCanvas.height);
        const drawLine = (ctx, canvas, data, color) => {
            ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
            const step = canvas.width / (data.length - 1);
            data.forEach((val, i) => { const x = i * step; const y = canvas.height - (val / 100 * canvas.height); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
            ctx.stroke();
        };
        drawLine(cpuCtx, cpuCanvas, cpuData, '#16a34a');
        drawLine(ramCtx, ramCanvas, ramData, '#3b82f6');
    };
    const updateStats = async () => {
        const stats = await window.electronAPI.getStats(activeFolder);
        cpuData.push(stats.cpu); cpuData.shift();
        ramData.push(stats.ram); ramData.shift();
        const cpuLabel = document.getElementById('cpuLabelValue');
        const ramLabel = document.getElementById('ramLabelValue');
        if (cpuLabel) cpuLabel.innerText = activeConfig.status === 'online' ? `${stats.cpu}%` : "Offline";
        if (ramLabel) ramLabel.innerText = activeConfig.status === 'online' ? `${stats.usedRamGB.toFixed(1)} / ${stats.totalRamGB} GB` : "Offline";
        draw();
    };
    updateStats(); statsInterval = setInterval(updateStats, 1000); window.addEventListener('resize', draw);
}

const controlStartBtn = document.getElementById('controlStartBtn');
const controlStopBtn = document.getElementById('controlStopBtn');
const controlKillBtn = document.getElementById('controlKillBtn');
const cmdInput = document.getElementById('cmdInput');
function updateWorkspaceStatus(status, port) {
    const label = document.getElementById('activeServerStatusLabel');
    if(status === 'online') {
        label.innerHTML = `<span class="status-dot status-online"></span>Online ${port || activeConfig.port}`;
        controlStartBtn.disabled = true; controlStopBtn.disabled = false; controlStopBtn.innerText = "Stop"; controlStopBtn.style.display = "block"; controlKillBtn.style.display = "none";
        activeConfig.status = 'online';
    } else {
        label.innerHTML = '<span class="status-dot status-offline"></span>Offline';
        controlStartBtn.disabled = false; controlStopBtn.disabled = true; controlStopBtn.style.display = "block"; controlStopBtn.innerText = "Stop"; controlKillBtn.style.display = "none";
        activeConfig.status = 'offline';
    }
}
controlStartBtn.addEventListener('click', async () => {
    controlStartBtn.disabled = true; 
    const res = await window.electronAPI.startServer(activeFolder);
    if(!res.success) { if (terminalOutput) terminalOutput.innerText += `[Error]: ${res.message}\n`; controlStartBtn.disabled = false; }
});
controlStopBtn.addEventListener('click', () => { window.electronAPI.stopServer(activeFolder); controlStopBtn.style.display = "none"; if (controlKillBtn) controlKillBtn.style.display = "block"; });
controlKillBtn.addEventListener('click', () => { requestConfirmation("Force kill? Proceed?", () => window.electronAPI.killServer(activeFolder)); });
window.electronAPI.onConsoleLog((folder, data) => {
    if (!serverLogs[folder]) serverLogs[folder] = ""; serverLogs[folder] += data;
    if (serverLogs[folder].length > 100000) serverLogs[folder] = serverLogs[folder].slice(-100000); 
    if (folder === activeFolder) { terminalOutput.innerText = serverLogs[folder]; terminalOutput.scrollTop = terminalOutput.scrollHeight; }
});
window.electronAPI.onServerStatus((folder, status, port) => {
    if (folder === activeFolder) { 
        updateWorkspaceStatus(status, port); 
        if(status === 'offline') { serverLogs[folder] += `\nconnection terminated.\n`; terminalOutput.innerText = serverLogs[folder]; }
        else if(status === 'online') { controlStopBtn.disabled = false; }
    }
    syncList();
});
document.getElementById('sendCmdBtn').addEventListener('click', processCommand);
cmdInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') processCommand(); });
function processCommand() {
    if (!cmdInput) return;
    let cmd = cmdInput.value.trim(); if(!cmd) return;
    if (cmd.startsWith(',')) {
        if (cmd === ',clear') {
            serverLogs[activeFolder] = "";
            if (terminalOutput) terminalOutput.innerText = "";
        } else {
            serverLogs[activeFolder] += `[Manager] Unknown cmd: ${cmd}\n`;
            if (terminalOutput) terminalOutput.innerText = serverLogs[activeFolder];
        }
    } 
    else {
        if(activeConfig.status === 'online') window.electronAPI.sendCommand(activeFolder, cmd);
        else {
            serverLogs[activeFolder] += `[Manager] Offline.\n`;
            if (terminalOutput) terminalOutput.innerText = serverLogs[activeFolder];
        }
    }
    cmdInput.value = "";
}

const backBtn = document.getElementById('fileBackBtn'); 
const editorArea = document.getElementById('configEditorArea');
editorArea.addEventListener('input', () => { hasUnsavedChanges = true; const fn = document.getElementById('editorFileName'); if (fn && !fn.innerText.includes('new')) fn.innerText = editingFilePath + " new"; });
window.addEventListener('click', () => { const _ctxMenu = document.getElementById('fileContextMenu'); if (_ctxMenu) _ctxMenu.style.display = 'none'; });
function navigateTo(path, recordHistory = true) {
    if (recordHistory) { pathHistory = pathHistory.slice(0, historyIndex + 1); pathHistory.push(path); historyIndex++; }
    currentPath = path; loadFilesCustom();
}
backBtn.addEventListener('click', () => { if (historyIndex > 0) { historyIndex--; currentPath = pathHistory[historyIndex]; loadFilesCustom(); } });

async function loadFilesCustom() {
    const filesContainer = document.getElementById('filesContainer'); 
    if (!filesContainer) return;
    filesContainer.innerHTML = "";
    const pathDisplay = document.getElementById('currentPathDisplay');
    if (pathDisplay) pathDisplay.innerText = " / " + currentPath;
    if (backBtn) backBtn.disabled = historyIndex <= 0; 
    const files = await window.electronAPI.listFiles(activeFolder, currentPath);
    bulkSelection = [];
    const bar = document.getElementById('bulkActionBar');
    if (bar) bar.style.display = 'none';
    
    files.forEach(f => {
        const itemRow = document.createElement('div'); itemRow.className = 'file-card';
        const ext = f.name.includes('.') ? f.name.split('.').pop().substring(0,4).toUpperCase() : 'FILE';
        const prefixHTML = f.isDirectory ? `<span class="file-badge dir-badge">DIR</span>` : `<span class="file-badge">${ext}</span>`;
        const newSuffix = (f.name.includes('destructions-config.json') || f.name.startsWith('new_')) ? '<span class="file-badge new-badge">NEW</span>' : '';
        
        itemRow.innerHTML = `<span style="display:flex; align-items:center;">${prefixHTML} <span>${f.name}</span> ${newSuffix}</span>`;
        
        itemRow.addEventListener('click', (e) => {
            bulkSelection = [{ path: currentPath ? `${currentPath}/${f.name}` : f.name, name: f.name }];
            document.querySelectorAll('.file-card').forEach(el => el.style.borderColor = 'var(--border-color)');
            itemRow.style.borderColor = 'var(--btn-green)';
            if (bar) bar.style.display = 'flex';
        });

        itemRow.addEventListener('dblclick', () => {
            if (f.isDirectory) {
                navigateTo(currentPath ? `${currentPath}/${f.name}` : f.name);
            } else {
                if (f.name === 'destructions-config.json') {
                    customAlert("This core configuration file is locked and cannot be edited directly.");
                    return;
                }
                const binaryExts = ['.jar', '.exe', '.dll', '.zip', '.tar.gz', '.world', '.dat', '.mca'];
                if (binaryExts.some(ext => f.name.toLowerCase().endsWith(ext))) {
                    requestConfirmation(`Cannot open ${f.name} in the text editor. Open with your computer's external default program?`, () => {
                        const targetPath = currentPath ? `${currentPath}/${f.name}` : f.name;
                        window.electronAPI.openExternal(activeFolder, targetPath);
                    });
                    return;
                }
                openEditor(f.name);
            }
        });

        itemRow.addEventListener('contextmenu', (e) => {
            e.preventDefault(); e.stopPropagation();
            selectedContextItem = currentPath ? `${currentPath}/${f.name}` : f.name;
            const menu = document.getElementById('fileContextMenu');
            if (menu) {
                menu.style.display = 'flex'; menu.style.left = `${e.clientX}px`; menu.style.top = `${e.clientY}px`;
            }
        });
        filesContainer.appendChild(itemRow);
    });
}

const _ctxDelete = document.getElementById('ctxDelete');
if (_ctxDelete) { _ctxDelete.addEventListener('click', () => {
    if(!selectedContextItem) return;
    requestConfirmation(`Delete ${selectedContextItem}?`, async () => { await window.electronAPI.deleteFileItem(activeFolder, selectedContextItem); loadFilesCustom(); });
}); }
const _ctxRename = document.getElementById('ctxRename');
if (_ctxRename) { _ctxRename.addEventListener('click', async () => {
    if(!selectedContextItem) return; 
    const newName = await customPrompt("Enter new name:"); 
    if(!newName) return;
    const parts = selectedContextItem.split('/'); parts[parts.length - 1] = newName; const dest = parts.join('/');
    window.electronAPI.moveFileItem(activeFolder, selectedContextItem, dest).then(() => loadFilesCustom());
}); }
const _ctxMove = document.getElementById('ctxMove');
if (_ctxMove) { _ctxMove.addEventListener('click', () => {
    if(!selectedContextItem) return; 
    moveSourcePaths = [selectedContextItem];
    loadMiniExplorer(""); 
}); }

const dropOverlay = document.getElementById('fileDropOverlay');
const browserView = document.getElementById('fileBrowserView');
browserView.addEventListener('dragover', (e) => { e.preventDefault(); dropOverlay.style.display = 'flex'; });
browserView.addEventListener('dragleave', (e) => { if (e.relatedTarget === null || !browserView.contains(e.relatedTarget)) dropOverlay.style.display = 'none'; });
browserView.addEventListener('drop', async (e) => {
    e.preventDefault(); dropOverlay.style.display = 'none';
    if (!activeFolder) return;
    for (let f of e.dataTransfer.files) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            await window.electronAPI.writeFile(activeFolder, currentPath ? `${currentPath}/${f.name}` : f.name, event.target.result);
            loadFilesCustom();
        };
        reader.readAsText(f);
    }
});
document.getElementById('uploadFileTriggerBtn').addEventListener('click', () => { document.getElementById('hiddenFileInput').click(); });
document.getElementById('hiddenFileInput').addEventListener('change', async (e) => {
    if (!activeFolder) return;
    for (let f of e.target.files) {
        const reader = new FileReader();
        reader.onload = async (event) => {
            await window.electronAPI.writeFile(activeFolder, currentPath ? `${currentPath}/${f.name}` : f.name, event.target.result);
            loadFilesCustom();
        };
        reader.readAsText(f);
    }
    e.target.value = "";
});

async function openEditor(filename) {
    editingFilePath = currentPath ? `${currentPath}/${filename}` : filename; document.getElementById('editorFileName').innerText = "Location: /" + editingFilePath;
    document.getElementById('fileBrowserView').style.display = 'none'; document.getElementById('fileEditorView').classList.add('active'); hasUnsavedChanges = false;
    document.getElementById('configEditorArea').value = await window.electronAPI.readFile(activeFolder, editingFilePath);
}
function attemptCloseEditor() { 
    if (hasUnsavedChanges) { requestUnsavedConfirmation(() => { hasUnsavedChanges = false; closeEditor(); }); } else { closeEditor(); }
}
function closeEditor() { editingFilePath = ""; hasUnsavedChanges = false; document.getElementById('fileEditorView').classList.remove('active'); document.getElementById('fileBrowserView').style.display = 'flex'; loadFilesCustom(); }
document.getElementById('saveEditorBtn').addEventListener('click', async () => {
    await window.electronAPI.writeFile(activeFolder, editingFilePath, editorArea.value); hasUnsavedChanges = false;
    document.getElementById('editorFileName').innerText = "Location: /" + editingFilePath; const btn = document.getElementById('saveEditorBtn'); btn.innerText = "Saved!"; setTimeout(() => btn.innerText = "Save Changes", 1500);
});
window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 's' && document.getElementById('fileEditorView').classList.contains('active')) { e.preventDefault(); document.getElementById('saveEditorBtn').click(); } });
window.addEventListener('mouseup', (e) => { if (e.button === 3) { if (document.getElementById('fileEditorView').classList.contains('active')) attemptCloseEditor(); else if (document.getElementById('viewDashboard').classList.contains('active') && historyIndex > 0 && !hasUnsavedChanges) backBtn.click(); } });
const jarSelect = document.getElementById('jarSelect'); const versionSelect = document.getElementById('versionSelect'); const saveServerBtn = document.getElementById('saveServerBtn'); let cachedVersions = { Vanilla: [], Snapshot: [], Paper: [], Purpur: [], Velocity: [], Waterfall: [], Folia: [] };

async function fetchVersions(type) {
    if (type === 'Custom' || (cachedVersions[type] && cachedVersions[type].length > 0)) return;
    try {
        if (type === 'Vanilla' || type === 'Snapshot') {
            const res = await (await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json')).json();
            cachedVersions.Vanilla = res.versions.filter(v => v.type === 'release').map(v => ({ id: v.id, url: v.url }));
            cachedVersions.Snapshot = res.versions.filter(v => v.type === 'snapshot').map(v => ({ id: v.id, url: v.url }));
        }
        else if (type === 'Paper' || type === 'Velocity' || type === 'Waterfall' || type === 'Folia') {
            const proj = type.toLowerCase();
            const res = await (await fetch(`https://api.papermc.io/v2/projects/${proj}`)).json();
            cachedVersions[type] = res.versions.reverse().map(v => ({ id: v }));
        }
        else if (type === 'Purpur') cachedVersions.Purpur = (await (await fetch('https://api.purpurmc.org/v2/purpur')).json()).versions.reverse().map(v => ({ id: v }));
    } catch (e) {}
}
async function populateVersions(jSelect, vSelect, btn) {
    if (!jSelect || !vSelect) return;
    vSelect.innerHTML = '<option value="">Loading versions...</option>'; if(btn) btn.disabled = true; 
    const type = jSelect.value;
    if (type === 'Custom') {
        const vContainer = document.getElementById('versionSelectContainer');
        const cContainer = document.getElementById('customFileContainer');
        if (vContainer) vContainer.style.display = 'none';
        if (cContainer) cContainer.style.display = 'block';
        const hotCustomFile = document.getElementById('hotCustomFileInput');
        if (hotCustomFile) {
            const hotVSelect = document.getElementById('hotVersionSelect');
            if (hotVSelect) hotVSelect.style.display = 'none';
            hotCustomFile.style.display = 'block';
        }
        if(btn) btn.disabled = false;
        return;
    } else {
        const vContainer = document.getElementById('versionSelectContainer');
        const cContainer = document.getElementById('customFileContainer');
        if (vContainer) vContainer.style.display = 'block';
        if (cContainer) cContainer.style.display = 'none';
        const hotCustomFile = document.getElementById('hotCustomFileInput');
        if (hotCustomFile) {
            const hotVSelect = document.getElementById('hotVersionSelect');
            if (hotVSelect) hotVSelect.style.display = 'block';
            hotCustomFile.style.display = 'none';
        }
    }
    await fetchVersions(type);
    vSelect.innerHTML = '';
    const versions = cachedVersions[type] || [];
    versions.forEach(v => { const opt = document.createElement('option'); opt.value = v.id; opt.innerText = v.id; vSelect.appendChild(opt); }); if(btn) btn.disabled = false;
}
jarSelect.addEventListener('change', () => populateVersions(jarSelect, versionSelect, saveServerBtn));
document.getElementById('openModalBtn').addEventListener('click', () => { 
    const nameInput = document.getElementById('serverNameInput');
    if (nameInput) nameInput.value = ""; 
    const addServerModal = document.getElementById('addServerModal');
    if (addServerModal) { addServerModal.classList.add('active'); if (versionSelect && versionSelect.options.length <= 1) { populateVersions(jarSelect, versionSelect, saveServerBtn); } } 
});
async function getDownloadUrl(type, version, fileInputId) {
    if (type === 'Custom') {
        const fileInput = document.getElementById(fileInputId);
        if (fileInput && fileInput.files.length > 0) return "file://" + fileInput.files[0].path;
        return "";
    }
    if (type === 'Vanilla' || type === 'Snapshot') {
        const category = cachedVersions[type];
        if (!category) return "";
        const entry = category.find(v => v.id === version);
        if (!entry) return "";
        const res = await fetch(entry.url);
        const data = await res.json();
        return data.downloads && data.downloads.server ? data.downloads.server.url : "";
    }
    if (type === 'Paper' || type === 'Velocity' || type === 'Waterfall' || type === 'Folia') { const buildData = await (await fetch(`https://api.papermc.io/v2/projects/${type.toLowerCase()}/versions/${version}`)).json(); return `https://api.papermc.io/v2/projects/${type.toLowerCase()}/versions/${version}/builds/${buildData.builds[buildData.builds.length - 1]}/downloads/${type.toLowerCase()}-${version}-${buildData.builds[buildData.builds.length - 1]}.jar`; } 
    if (type === 'Purpur') return `https://api.purpurmc.org/v2/purpur/${version}/latest/download`;
    return ""; 
}
document.getElementById('saveServerBtn').addEventListener('click', async () => {
    systemMaxRam = await window.electronAPI.getSystemRam();
    let chosenRam = parseInt(document.getElementById('ramSelect').value); if(chosenRam > systemMaxRam) { await customAlert("Cannot exceed system RAM!"); return; }
    saveServerBtn.innerText = "Installing..."; saveServerBtn.disabled = true; const type = jarSelect.value; const version = versionSelect.value; 
    const finalDownloadUrl = await getDownloadUrl(type, version, 'customFileInput');
    if (!finalDownloadUrl) { await customAlert("Missing URL or File"); saveServerBtn.innerText = "Install Server"; saveServerBtn.disabled = false; return; }
    const nameInput = document.getElementById('serverNameInput'); const portSelect = document.getElementById('portSelect');
    const res = await window.electronAPI.createServer({ name: (nameInput ? nameInput.value : "") || "New_Server", type: type, version: version || "Custom", downloadUrl: finalDownloadUrl, ram: chosenRam.toString(), port: portSelect ? portSelect.value : "25565" });
    saveServerBtn.innerText = "Install Server"; saveServerBtn.disabled = false; if(res.success) { const modal = document.getElementById('addServerModal'); if (modal) modal.classList.remove('active'); syncList(); } else await customAlert(res.message);
});
const hotJarSelect = document.getElementById('hotJarSelect'); const hotVersionSelect = document.getElementById('hotVersionSelect'); const hotLoadBtn = document.getElementById('hotLoadBtn');
hotJarSelect.addEventListener('change', () => populateVersions(hotJarSelect, hotVersionSelect, hotLoadBtn));
hotLoadBtn.addEventListener('click', async () => {
    hotLoadBtn.disabled = true; hotLoadBtn.innerText = "Processing...";
    const type = hotJarSelect.value; const version = hotVersionSelect.value;
    const finalDownloadUrl = await getDownloadUrl(type, version, 'hotCustomFileInput');
    if (!finalDownloadUrl) { await customAlert("Missing URL or File"); hotLoadBtn.innerText = "Replace & Download"; hotLoadBtn.disabled = false; return; }
    const res = await window.electronAPI.hotLoadJar(activeFolder, finalDownloadUrl);
    if (res.success) {
        activeConfig.type = type; activeConfig.version = version || "Custom";
        await window.electronAPI.saveConfig(activeFolder, activeConfig);
        document.getElementById('changeJarModal').classList.remove('active');
        syncList();
    } else await customAlert(res.message);
    hotLoadBtn.innerText = "Replace & Download"; hotLoadBtn.disabled = false;
});

async function loadBackups() {
    const container = document.getElementById('backupsContainer'); container.innerHTML = ""; const backups = await window.electronAPI.listBackups(activeFolder);
    if(backups.length === 0) container.innerHTML = `<div style="color:var(--text-muted); font-size:0.9rem;">No snapshots found.</div>`;
    backups.forEach(b => {
        const card = document.createElement('div'); card.className = 'server-card'; card.style.cursor = 'default';
        card.innerHTML = `<div style="flex:1;" class="backup-info"><h3 style="margin:0 0 4px 0; font-size:1rem;" class="backup-name-display">${b}</h3><span style="color:var(--text-muted); font-size:0.8rem;">Snapshot Data</span></div><button class="btn-base btn-kill delete-backup-btn">Delete</button>`;
        const titleEl = card.querySelector('.backup-name-display');
        
        titleEl.addEventListener('dblclick', async () => {
            const newName = await customPrompt("Enter new backup name:", b);
            if (newName && newName !== b) {
                await window.electronAPI.renameBackup(activeFolder, b, newName);
                loadBackups();
            }
        });
        card.querySelector('.delete-backup-btn').addEventListener('click', () => { requestConfirmation(`Delete backup ${b}?`, async () => { await window.electronAPI.deleteBackup(activeFolder, b); loadBackups(); }); }); container.appendChild(card);
    });
}
document.getElementById('createBackupBtn').addEventListener('click', async () => {
    const btn = document.getElementById('createBackupBtn'); const nameInput = document.getElementById('backupNameInput');
    btn.innerText = "Zipping..."; btn.disabled = true; const res = await window.electronAPI.createBackup(activeFolder, nameInput.value.trim());
    btn.innerText = "Create Backup"; btn.disabled = false; nameInput.value = "";
    if(!res.success) await customAlert(`Backup failed:\n${res.message}`); loadBackups();
});

const taskTriggerSelect = document.getElementById('taskTriggerSelect');
taskTriggerSelect.addEventListener('change', () => {
    const container = document.getElementById('taskTimerContainer');
    if (container) { container.style.display = taskTriggerSelect.value === 'interval_timer' ? 'grid' : 'none'; }
});
const taskActionSelect = document.getElementById('taskActionSelect');
taskActionSelect.addEventListener('change', () => {
    const cmdVal = document.getElementById('taskCommandVal');
    if (cmdVal) { cmdVal.style.display = taskActionSelect.value === 'send_command' ? 'block' : 'none'; }
});
document.getElementById('createTaskBtn').addEventListener('click', async () => {
    const nameInput = document.getElementById('taskNameInput'); const name = nameInput ? nameInput.value.trim() : ""; if (!name) return;
    const timerValEl = document.getElementById('taskTimerVal'); const timerUnitEl = document.getElementById('taskTimerUnit'); const cmdValEl = document.getElementById('taskCommandVal');
    
    const task = { 
        id: 'task_' + Date.now(), 
        name, 
        enabled: true,
        trigger: taskTriggerSelect ? taskTriggerSelect.value : 'interval_timer', 
        timerVal: timerValEl ? timerValEl.value : '30', 
        timerUnit: timerUnitEl ? timerUnitEl.value : 's', 
        action: taskActionSelect ? taskActionSelect.value : 'create_backup', 
        customCommand: cmdValEl ? cmdValEl.value : "" 
    };
    
    await window.electronAPI.saveTask(activeFolder, task); 
    if (nameInput) nameInput.value = ""; 
    if (cmdValEl) cmdValEl.value = ""; 
    loadTasks();
});

const editTaskTriggerSelect = document.getElementById('editTaskTriggerSelect');
editTaskTriggerSelect.addEventListener('change', () => {
    const container = document.getElementById('editTaskTimerContainer');
    if (container) { container.style.display = editTaskTriggerSelect.value === 'interval_timer' ? 'grid' : 'none'; }
});
const editTaskActionSelect = document.getElementById('editTaskActionSelect');
editTaskActionSelect.addEventListener('change', () => {
    const cmdVal = document.getElementById('editTaskCommandVal');
    if (cmdVal) { cmdVal.style.display = editTaskActionSelect.value === 'send_command' ? 'block' : 'none'; }
});

document.getElementById('saveEditedTaskBtn').addEventListener('click', async () => {
    const name = document.getElementById('editTaskNameInput').value.trim(); if (!name) return;
    const task = {
        id: document.getElementById('editTaskId').value,
        name: name,
        enabled: document.getElementById('editTaskEnabled').value === 'true',
        trigger: document.getElementById('editTaskTriggerSelect').value,
        timerVal: document.getElementById('editTaskTimerVal').value,
        timerUnit: document.getElementById('editTaskTimerUnit').value,
        action: document.getElementById('editTaskActionSelect').value,
        customCommand: document.getElementById('editTaskCommandVal').value
    };
    await window.electronAPI.saveTask(activeFolder, task);
    document.getElementById('editTaskModal').classList.remove('active');
    loadTasks();
});

async function loadTasks() {
    const container = document.getElementById('tasksContainer'); if (!container) return; container.innerHTML = ""; const tasks = await window.electronAPI.listTasks(activeFolder);
    if(tasks.length === 0) container.innerHTML = `<div style="color:var(--text-muted); font-size:0.9rem;">No scheduled tasks configured.</div>`;
    tasks.forEach(t => {
        const card = document.createElement('div'); card.className = 'server-card'; card.style.cursor = 'default';
        let detailText = `Trigger: ${t.trigger}`; if (t.trigger === 'interval_timer') { detailText += ` (Every ${t.timerVal}${t.timerUnit})`; } detailText += ` | Action: ${t.action}`;
        let isChecked = t.enabled !== false ? 'checked' : '';
        
        card.innerHTML = `
            <div style="flex:1;">
                <h3 style="margin:0 0 4px 0; font-size:1rem;" class="task-name-display">${t.name}</h3>
                <span style="color:var(--text-muted); font-size:0.8rem;">${detailText}</span>
            </div>
            <div style="display:flex; gap:10px; align-items:center;">
                <label class="switch"><input type="checkbox" class="task-toggle-btn" ${isChecked}><span class="slider"></span></label>
                <button class="btn-base edit-task-btn">Edit</button>
                <button class="btn-base btn-kill delete-task-btn">Delete</button>
            </div>
        `;
        const titleEl = card.querySelector('.task-name-display');
        
        if (titleEl) { 
            titleEl.addEventListener('dblclick', async () => { 
                const newName = await customPrompt("Enter new task name:", t.name);
                if(newName && newName !== t.name) { 
                    t.name = newName; 
                    await window.electronAPI.saveTask(activeFolder, t); 
                    loadTasks(); 
                } 
            }); 
        }

        const toggleBtn = card.querySelector('.task-toggle-btn');
        if(toggleBtn) {
            toggleBtn.addEventListener('change', async (e) => {
                t.enabled = e.target.checked;
                await window.electronAPI.saveTask(activeFolder, t);
            });
        }

        const editBtn = card.querySelector('.edit-task-btn');
        if(editBtn) {
            editBtn.addEventListener('click', () => {
                document.getElementById('editTaskId').value = t.id;
                document.getElementById('editTaskEnabled').value = t.enabled;
                document.getElementById('editTaskNameInput').value = t.name;
                document.getElementById('editTaskTriggerSelect').value = t.trigger;
                document.getElementById('editTaskTimerVal').value = t.timerVal || '30';
                document.getElementById('editTaskTimerUnit').value = t.timerUnit || 's';
                document.getElementById('editTaskActionSelect').value = t.action;
                document.getElementById('editTaskCommandVal').value = t.customCommand || '';
                
                document.getElementById('editTaskTimerContainer').style.display = t.trigger === 'interval_timer' ? 'grid' : 'none';
                document.getElementById('editTaskCommandVal').style.display = t.action === 'send_command' ? 'block' : 'none';
                
                document.getElementById('editTaskModal').classList.add('active');
            });
        }

        const delBtn = card.querySelector('.delete-task-btn'); if (delBtn) { delBtn.addEventListener('click', () => { requestConfirmation(`Delete task ${t.name}?`, async () => { await window.electronAPI.deleteTask(activeFolder, t.id); loadTasks(); }); }); }
        container.appendChild(card);
    });
}

const saveSettingsBtn = document.getElementById('saveSettingsBtn');
if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', async () => {
        const nameInput = document.getElementById('setServerName'); const descInput = document.getElementById('setServerDesc'); const autoUpdateToggle = document.getElementById('loadAutoUpdateToggle'); const autoRestartInput = document.getElementById('loadAutoRestart'); const javaVerInput = document.getElementById('loadJavaVer'); const flagsInput = document.getElementById('loadStartupFlags');
        if (nameInput) activeConfig.name = nameInput.value; if (descInput) activeConfig.description = descInput.value; if (autoUpdateToggle) activeConfig.autoUpdate = autoUpdateToggle.checked ? 'yes' : 'no'; if (autoRestartInput) activeConfig.autoRestart = autoRestartInput.checked; if (javaVerInput) activeConfig.javaVersion = javaVerInput.value; if (flagsInput) activeConfig.startupFlags = flagsInput.value;
        await window.electronAPI.saveConfig(activeFolder, activeConfig); const titleEl = document.getElementById('activeServerTitle'); if (titleEl) titleEl.innerText = activeConfig.name; 
        await customAlert("Settings saved successfully!");
    });
}
const resetWorldBtn = document.getElementById('resetWorldBtn'); if (resetWorldBtn) { resetWorldBtn.addEventListener('click', () => { requestConfirmation("This will permanently delete the Overworld, Nether, and End. Proceed?", async () => { await window.electronAPI.resetWorld(activeFolder); }); }); }
const resetServerBtn = document.getElementById('resetServerBtn'); if (resetServerBtn) { resetServerBtn.addEventListener('click', () => { requestConfirmation("This will delete ALL plugins, worlds, and config files except the core manager files. Proceed?", async () => { await window.electronAPI.resetServer(activeFolder); }); }); }
const wipePlayersBtn = document.getElementById('wipePlayersBtn'); if (wipePlayersBtn) { wipePlayersBtn.addEventListener('click', () => { requestConfirmation("Are you sure you want to wipe all player data?", async () => { await window.electronAPI.wipePlayerData(activeFolder); }); }); }
const clearLogsBtn = document.getElementById('clearLogsBtn'); if (clearLogsBtn) { clearLogsBtn.addEventListener('click', () => { requestConfirmation("Are you sure you want to clear all log files?", async () => { await window.electronAPI.clearLogs(activeFolder); }); }); }
const purgeCacheBtn = document.getElementById('purgeCacheBtn'); if (purgeCacheBtn) { purgeCacheBtn.addEventListener('click', () => { requestConfirmation("Are you sure you want to purge temp cache?", async () => { await window.electronAPI.purgeCache(activeFolder); }); }); }

const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener('click', () => {
        if (bulkSelection.length === 0) return;
        requestConfirmation(`Delete ${bulkSelection.length} selected items?`, async () => { for (const item of bulkSelection) { await window.electronAPI.deleteFileItem(activeFolder, item.path); } loadFilesCustom(); });
    });
}
const bulkRenameBtn = document.getElementById('bulkRenameBtn');
if (bulkRenameBtn) {
    bulkRenameBtn.addEventListener('click', async () => {
        if (bulkSelection.length !== 1) return; const item = bulkSelection[0]; 
        const newName = await customPrompt("Enter new name:", item.name); 
        if (!newName) return;
        const parts = item.path.split('/'); parts[parts.length - 1] = newName; const dest = parts.join('/'); window.electronAPI.moveFileItem(activeFolder, item.path, dest).then(() => loadFilesCustom());
    });
}

async function loadMiniExplorer(renderPath) {
    const container = document.getElementById('miniExplorerContainer');
    container.innerHTML = "<div style='color:var(--text-muted); padding:10px;'>Loading...</div>";
    
    const files = await window.electronAPI.listFiles(activeFolder, renderPath);
    container.innerHTML = "";
    
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    let displayPath = renderPath === "" ? "/" : "/" + renderPath;
    
    const rootEl = document.createElement('div');
    rootEl.className = 'mini-folder-item selected';
    rootEl.innerHTML = `📁 ${displayPath} (Move Here)`;
    rootEl.dataset.path = renderPath;
    
    confirmMoveBtn.dataset.targetPath = renderPath;

    rootEl.onclick = () => {
        document.querySelectorAll('.mini-folder-item').forEach(el => el.classList.remove('selected'));
        rootEl.classList.add('selected');
        confirmMoveBtn.dataset.targetPath = renderPath;
    };
    container.appendChild(rootEl);

    if (renderPath !== "") {
        const upEl = document.createElement('div');
        upEl.className = 'mini-folder-item';
        upEl.innerHTML = `🔙 .. (Go Up Directory)`;
        upEl.onclick = () => {
            const parts = renderPath.split('/');
            parts.pop();
            loadMiniExplorer(parts.join('/'));
        };
        container.appendChild(upEl);
    }

    files.forEach(f => {
        if(f.isDirectory) {
            const row = document.createElement('div');
            row.className = 'mini-folder-item';
            const fullPath = renderPath ? `${renderPath}/${f.name}` : f.name;
            row.dataset.path = fullPath;
            row.innerHTML = `&nbsp;&nbsp;↳ 📁 ${f.name}`;
            
            row.onclick = () => {
                document.querySelectorAll('.mini-folder-item').forEach(el => el.classList.remove('selected'));
                row.classList.add('selected');
                confirmMoveBtn.dataset.targetPath = fullPath;
            };
            
            row.ondblclick = () => {
                loadMiniExplorer(fullPath);
            };
            container.appendChild(row);
        }
    });

    document.getElementById('moveModal').classList.add('active');
}

const bulkMoveBtn = document.getElementById('bulkMoveBtn'); 
if (bulkMoveBtn) { bulkMoveBtn.addEventListener('click', () => { 
    if (bulkSelection.length === 0) return; 
    moveSourcePaths = bulkSelection.map(i => i.path); 
    loadMiniExplorer("");
}); }

const confirmMoveBtn = document.getElementById('confirmMoveBtn');
if (confirmMoveBtn) {
    confirmMoveBtn.addEventListener('click', async () => {
        const destFolder = confirmMoveBtn.dataset.targetPath || ""; 
        for (const src of moveSourcePaths) { 
            const fileName = src.split('/').pop(); 
            const dest = destFolder ? `${destFolder}/${fileName}` : fileName; 
            await window.electronAPI.moveFileItem(activeFolder, src, dest); 
        }
        const modal = document.getElementById('moveModal'); if (modal) modal.classList.remove('active'); loadFilesCustom();
    });
}

const newItemTriggerBtn = document.getElementById('newItemTriggerBtn'); 
if (newItemTriggerBtn) { 
    newItemTriggerBtn.addEventListener('click', () => { 
        document.getElementById('newItemNameInput').value = "";
        document.getElementById('newItemModal').classList.add('active');
        document.getElementById('newItemNameInput').focus();
    }); 
}

document.getElementById('createNewFileBtnFinal').addEventListener('click', async () => {
    const name = document.getElementById('newItemNameInput').value.trim();
    if(!name) return;
    const finalName = name.startsWith('new_') ? name : `new_${name}`;
    await window.electronAPI.createNewItem(activeFolder, currentPath, finalName, false);
    document.getElementById('newItemModal').classList.remove('active');
    loadFilesCustom();
});

document.getElementById('createNewFolderBtnFinal').addEventListener('click', async () => {
    const name = document.getElementById('newItemNameInput').value.trim();
    if(!name) return;
    const finalName = name.startsWith('new_') ? name : `new_${name}`;
    await window.electronAPI.createNewItem(activeFolder, currentPath, finalName, true);
    document.getElementById('newItemModal').classList.remove('active');
    loadFilesCustom();
});

syncList();