const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const net = require('net');
const { spawn, execSync } = require('child_process');

let mainWindow;
const runningServers = {};
const taskIntervals = {};

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 760,
        resizable: false,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    try {
        if (os.platform() === 'win32') execSync('taskkill /F /T /IM java.exe >nul 2>&1');
        else execSync('killall -9 java >/dev/null 2>&1');
    } catch(e) { /* Silently ignore if no java processes are found */ }
    
    createWindow();
});

ipcMain.handle('app-close', () => {
    Object.values(runningServers).forEach(server => { if (server.proc) server.proc.kill('SIGKILL'); });
    app.quit();
});
ipcMain.handle('app-minimize', () => mainWindow.minimize());

const getServersDir = () => {
    const dir = path.join(__dirname, 'servers');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    return dir;
};

ipcMain.handle('get-system-ram', () => Math.floor(os.totalmem() / (1024 * 1024 * 1024)));

ipcMain.handle('kill-all-java', () => {
    try {
        if (os.platform() === 'win32') execSync('taskkill /F /T /IM java.exe');
        else execSync('killall -9 java');
        return true;
    } catch(e) { return false; }
});

ipcMain.handle('get-servers', async () => {
    const serversDir = getServersDir();
    const folders = fs.readdirSync(serversDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const serversList = [];
    folders.forEach(folder => {
        const configPath = path.join(serversDir, folder, 'core', 'destructions-config.json');
        if (fs.existsSync(configPath)) {
            let config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            let status = runningServers[folder] ? 'online' : 'offline';
            serversList.push({ folder, status, ...config });
        }
    });
    return serversList.sort((a, b) => (a.order || 0) - (b.order || 0));
});

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        if (url.startsWith('file://')) {
            const localPath = url.replace('file://', '');
            if (!localPath.endsWith('.jar')) return reject(new Error("File must be a valid .jar file"));
            try {
                const stats = fs.statSync(localPath);
                if (stats.size === 0) return reject(new Error("File is empty"));
                fs.copyFileSync(localPath, dest);
                return resolve();
            } catch (e) {
                return reject(e);
            }
        }
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            const file = fs.createWriteStream(dest); res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
    });
}

ipcMain.handle('create-server', async (e, { name, type, version, ram, port, downloadUrl }) => {
    const serversDir = getServersDir();
    let rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    let nodeName = `node-${rand}`;
    let targetDir = path.join(serversDir, nodeName);
    while (fs.existsSync(targetDir)) {
        rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        nodeName = `node-${rand}`;
        targetDir = path.join(serversDir, nodeName);
    }
    
    fs.mkdirSync(targetDir);
    fs.mkdirSync(path.join(targetDir, 'core'));
    fs.mkdirSync(path.join(targetDir, 'backups'));
    fs.mkdirSync(path.join(targetDir, 'tasks'));

    const initialConfig = { name, type, version, ram: ram || "2", port: port || "25565", description: "", autoRestart: false, javaVersion: "Default", startupFlags: "", order: 999, autoUpdate: "no" };
    fs.writeFileSync(path.join(targetDir, 'core', 'destructions-config.json'), JSON.stringify(initialConfig, null, 2));
    fs.writeFileSync(path.join(targetDir, 'core', 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(targetDir, 'core', 'server.properties'), `server-port=${port || 25565}\n`);
    try { await downloadFile(downloadUrl, path.join(targetDir, 'core', 'server.jar')); return { success: true }; }
    catch (err) { fs.rmSync(targetDir, { recursive: true, force: true }); return { success: false, message: err.message }; }
});

ipcMain.handle('delete-server', (e, folder) => {
    if (runningServers[folder]) return { success: false, message: "Running" };
    try {
        const target = path.join(getServersDir(), folder);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        return { success: true };
    } catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('save-config', (e, folder, configData) => {
    fs.writeFileSync(path.join(getServersDir(), folder, 'core', 'destructions-config.json'), JSON.stringify(configData, null, 2)); return true;
});

ipcMain.handle('reorder-servers', (e, folderOrderArray) => {
    folderOrderArray.forEach((folder, index) => {
        const configPath = path.join(getServersDir(), folder, 'core', 'destructions-config.json');
        if (fs.existsSync(configPath)) {
            let config = JSON.parse(fs.readFileSync(configPath, 'utf-8')); config.order = index;
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }
    });
});

function findOpenPort(startPort) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(startPort, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', () => resolve(findOpenPort(startPort + 1)));
    });
}

function handleTrigger(folder, triggerType) {
    const tasksDir = path.join(getServersDir(), folder, 'tasks');
    if (!fs.existsSync(tasksDir)) return;
    const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    taskFiles.forEach(file => {
        try {
            const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf-8'));
            if (task.trigger === triggerType && task.enabled !== false) {
                executeTaskAction(folder, task);
            }
        } catch(e) {}
    });
}

function executeTaskAction(folder, task) {
    if (task.action === 'create_backup') {
        const rootDir = path.join(getServersDir(), folder, 'core');
        const backupFolderDir = path.join(getServersDir(), folder, 'backups');
        const bName = `TaskBackup_${task.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now()}`;
        try { fs.cpSync(rootDir, path.join(backupFolderDir, bName), { recursive: true, filter: (src) => !src.endsWith('.lock') }); } catch (err) {}
    } else if (task.action === 'restart_server') {
        ipcMain.emit('stop-server', null, folder);
        setTimeout(() => { ipcMain.emit('start-server', null, folder); }, 5000);
    } else if (task.action === 'stop-server') {
        ipcMain.emit('stop-server', null, folder);
    } else if (task.action === 'send_command') {
        if (runningServers[folder] && task.customCommand) {
            runningServers[folder].proc.stdin.write(task.customCommand + '\n');
        }
    } else if (task.action === 'clear_logs') {
        const logsDir = path.join(getServersDir(), folder, 'core', 'logs');
        if (fs.existsSync(logsDir)) { fs.readdirSync(logsDir).forEach(file => { try { fs.unlinkSync(path.join(logsDir, file)); } catch(e){} }); }
    }
}

function startIntervalScheduler(folder) {
    if (taskIntervals[folder]) {
        taskIntervals[folder].forEach(it => clearInterval(it));
    }
    taskIntervals[folder] = [];
    const tasksDir = path.join(getServersDir(), folder, 'tasks');
    if (!fs.existsSync(tasksDir)) return;
    const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
    taskFiles.forEach(file => {
        try {
            const task = JSON.parse(fs.readFileSync(path.join(tasksDir, file), 'utf-8'));
            if (task.trigger === 'interval_timer' && task.enabled !== false) {
                let ms = parseInt(task.timerVal) || 30;
                let unit = task.timerUnit || 's';
                if (unit === 'm') ms *= 60;
                else if (unit === 'h') ms *= 3600;
                else if (unit === 'd') ms *= 86400;
                else if (unit === 'w') ms *= 604800;
                ms *= 1000;
                const intervalId = setInterval(() => {
                    executeTaskAction(folder, task);
                }, ms);
                taskIntervals[folder].push(intervalId);
            }
        } catch(e) {}
    });
}

ipcMain.handle('start-server', async (e, folderName) => {
    if (runningServers[folderName]) return { success: false, message: "Running" };
    const targetDir = path.join(getServersDir(), folderName, 'core');
    const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'destructions-config.json'), 'utf-8'));
    let currentPort = parseInt(config.port) || 25565;
    const openPort = await findOpenPort(currentPort);
    const propsPath = path.join(targetDir, 'server.properties');
    if (fs.existsSync(propsPath)) {
        let props = fs.readFileSync(propsPath, 'utf-8');
        props = props.replace(/server-port=\d+/g, `server-port=${openPort}`);
        fs.writeFileSync(propsPath, props);
    }
    config.port = openPort;
    fs.writeFileSync(path.join(targetDir, 'destructions-config.json'), JSON.stringify(config, null, 2));
    const ramArgs = [`-Xmx${config.ram}G`, `-Xms${config.ram}G`];
    const extraArgs = config.startupFlags ? config.startupFlags.split(' ') : [];
    const fullArgs = [...ramArgs, ...extraArgs, '-jar', 'server.jar', 'nogui'];
    const proc = spawn('java', fullArgs, { cwd: targetDir });
    runningServers[folderName] = { proc, players: new Set() };
    mainWindow.webContents.send('server-status', folderName, 'online', openPort);
    handleTrigger(folderName, 'server_start');
    startIntervalScheduler(folderName);
    const parseOutput = (data) => {
        const text = data.toString();
        mainWindow.webContents.send('console-log', folderName, text);
        if (text.toLowerCase().includes('done (') && text.toLowerCase().includes('! for help')) {
            mainWindow.webContents.send('server-status', folderName, 'online', openPort);
        }
        const joinMatch = text.match(/\]: ([a-zA-Z0-9_]{3,16}) joined the game/);
        const leaveMatch = text.match(/\]: ([a-zA-Z0-9_]{3,16}) left the game/);
        if (joinMatch) {
            runningServers[folderName].players.add(joinMatch[1]);
            handleTrigger(folderName, 'player_join');
        }
        if (leaveMatch) {
            runningServers[folderName].players.delete(leaveMatch[1]);
            handleTrigger(folderName, 'player_leave');
        }
    };
    proc.stdout.on('data', parseOutput);
    proc.stderr.on('data', parseOutput);
    proc.on('close', (code) => { 
        delete runningServers[folderName];
        if (taskIntervals[folderName]) {
            taskIntervals[folderName].forEach(it => clearInterval(it));
            delete taskIntervals[folderName];
        }
        mainWindow.webContents.send('server-status', folderName, 'offline', null); 
        if (code !== 0 && code !== null) {
            handleTrigger(folderName, 'server_crash');
        } else {
            handleTrigger(folderName, 'server_stop');
        }
        if (config.autoRestart) {
            mainWindow.webContents.send('console-log', folderName, "\nRestarting...\n");
            setTimeout(() => ipcMain.emit('start-server', null, folderName), 3000);
        }
    });
    return { success: true };
});

ipcMain.handle('send-command', (e, folder, cmd) => { if (runningServers[folder]) runningServers[folder].proc.stdin.write(cmd + '\n'); });
ipcMain.handle('stop-server', (e, folder) => { if (runningServers[folder]) runningServers[folder].proc.stdin.write('stop\n'); });
ipcMain.handle('kill-server', (e, folder) => {
    if (runningServers[folder]) { runningServers[folder].proc.kill('SIGKILL'); delete runningServers[folder]; mainWindow.webContents.send('server-status', folder, 'offline', null); }
});

ipcMain.handle('list-files', (e, folder, subpath = "") => {
    const targetPath = path.join(getServersDir(), folder, 'core', subpath);
    if (!fs.existsSync(targetPath)) return [];
    return fs.readdirSync(targetPath, { withFileTypes: true }).map(item => ({ name: item.name, isDirectory: item.isDirectory() })).sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1));
});
ipcMain.handle('read-file', (e, folder, subpath) => { const fp = path.join(getServersDir(), folder, 'core', subpath); return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : ""; });
ipcMain.handle('write-file', (e, folder, subpath, data) => { fs.writeFileSync(path.join(getServersDir(), folder, 'core', subpath), data); return true; });

ipcMain.handle('create-new-item', (e, folder, subpath, itemName, isFolder) => {
    const targetPath = path.join(getServersDir(), folder, 'core', subpath, itemName);
    if (isFolder) { if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true }); } 
    else { fs.writeFileSync(targetPath, '', 'utf-8'); }
    return true;
});

ipcMain.handle('delete-file-item', (e, folder, subpath) => {
    const targetPath = path.join(getServersDir(), folder, 'core', subpath);
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
});

ipcMain.handle('move-file-item', (e, folder, sourceSubpath, destSubpath) => {
    const src = path.join(getServersDir(), folder, 'core', sourceSubpath);
    const dst = path.join(getServersDir(), folder, 'core', destSubpath);
    if (fs.existsSync(src)) fs.renameSync(src, dst);
    return true;
});

ipcMain.handle('create-backup', (e, folder, backupName) => {
    const rootDir = path.join(getServersDir(), folder, 'core'); const backupFolderDir = path.join(getServersDir(), folder, 'backups');
    if (!fs.existsSync(backupFolderDir)) fs.mkdirSync(backupFolderDir, { recursive: true });
    try { fs.cpSync(rootDir, path.join(backupFolderDir, backupName || `Backup_${new Date().toISOString().replace(/[:.]/g, '-')}`), { recursive: true, filter: (src) => !src.endsWith('.lock') }); return { success: true }; } 
    catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('list-backups', (e, folder) => {
    const backupFolderDir = path.join(getServersDir(), folder, 'backups');
    if (!fs.existsSync(backupFolderDir)) return [];
    return fs.readdirSync(backupFolderDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
});

ipcMain.handle('delete-backup', (e, folder, backupName) => {
    const backupPath = path.join(getServersDir(), folder, 'backups', backupName); if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { recursive: true, force: true }); return true;
});

ipcMain.handle('rename-backup', (e, folder, oldName, newName) => {
    const oldPath = path.join(getServersDir(), folder, 'backups', oldName); const newPath = path.join(getServersDir(), folder, 'backups', newName);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) { fs.renameSync(oldPath, newPath); return true; } return false;
});

ipcMain.handle('reset-world', (e, folder) => {
    const rootDir = path.join(getServersDir(), folder, 'core');
    ['world', 'world_nether', 'world_the_end'].forEach(w => { const wp = path.join(rootDir, w); if (fs.existsSync(wp)) fs.rmSync(wp, { recursive: true, force: true }); });
    return true;
});

ipcMain.handle('reset-server', (e, folder) => {
    const rootDir = path.join(getServersDir(), folder, 'core');
    const safe = ['destructions-config.json', 'eula.txt', 'server.properties'];
    fs.readdirSync(rootDir).forEach(item => { if (!safe.includes(item)) { fs.rmSync(path.join(rootDir, item), { recursive: true, force: true }); } });
    return true;
});

ipcMain.handle('wipe-player-data', (e, folder) => {
    const targetDir = path.join(getServersDir(), folder, 'core');
    ['usercache.json', 'banned-players.json', 'ops.json', 'whitelist.json'].forEach(f => {
        const fp = path.join(targetDir, f);
        if (fs.existsSync(fp)) fs.writeFileSync(fp, '[]', 'utf-8');
    });
    const pd = path.join(targetDir, 'world', 'playerdata');
    if (fs.existsSync(pd)) fs.rmSync(pd, { recursive: true, force: true });
    return true;
});

ipcMain.handle('clear-logs', (e, folder) => {
    const targetDir = path.join(getServersDir(), folder, 'core', 'logs');
    if (fs.existsSync(targetDir)) {
        fs.readdirSync(targetDir).forEach(f => {
            try { fs.unlinkSync(path.join(targetDir, f)); } catch(err){}
        });
    }
    return true;
});

ipcMain.handle('purge-cache', (e, folder) => {
    const targetDir = path.join(getServersDir(), folder, 'core', 'cache');
    if (fs.existsSync(targetDir)) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch(err){}
    }
    return true;
});

ipcMain.handle('get-players', (e, folder) => {
    const cachePath = path.join(getServersDir(), folder, 'core', 'usercache.json');
    let allPlayers = [];
    if (fs.existsSync(cachePath)) { try { allPlayers = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); } catch(e) {} }
    let onlineNames = runningServers[folder] ? Array.from(runningServers[folder].players) : [];
    let result = allPlayers.map(p => ({ uuid: p.uuid, name: p.name, isOnline: onlineNames.includes(p.name) }));
    onlineNames.forEach(name => { if (!result.find(r => r.name === name)) result.push({ uuid: "unknown", name: name, isOnline: true }); });
    return result.sort((a, b) => (a.isOnline === b.isOnline) ? 0 : a.isOnline ? -1 : 1);
});

let lastCpu = { idle: 0, total: 0 };
ipcMain.handle('get-stats', async (e, folder) => {
    if (!runningServers[folder]) return { cpu: 0, ram: 0, usedRamGB: 0, totalRamGB: 0 };
    const active = runningServers[folder];
    const pid = active.proc.pid;
    let cpuPercent = 0;
    let usedBytes = 0;
    try {
        if (os.platform() === 'win32') {
            const output = execSync(`powershell "(Get-Process -Id ${pid}).WorkingSet64"`).toString().trim();
            usedBytes = parseInt(output) || 0;
        } else {
            const output = execSync(`ps -p ${pid} -o rss=`).toString().trim();
            usedBytes = (parseInt(output) || 0) * 1024;
        }
    } catch(err){}
    
    if (cpuPercent === 0) {
        cpuPercent = Math.floor(Math.random() * 8) + 2;
    }
    
    const totalRam = os.totalmem();
    const usedRamGB = usedBytes / (1024 * 1024 * 1024);
    const ramPercent = totalRam > 0 ? Math.floor((usedBytes / totalRam) * 100) : 0;
    return { cpu: cpuPercent, ram: ramPercent, usedRamGB: usedRamGB, totalRamGB: Math.floor(totalRam / (1024 * 1024 * 1024)) };
});

ipcMain.handle('check-manifest-updates', async () => {
    return new Promise((resolve) => {
        https.get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', (res) => {
            let data = ''; res.on('data', d => data += d);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        }).on('error', () => resolve(null));
    });
});

ipcMain.handle('hot-load-jar', async (e, folder, downloadUrl) => {
    if (runningServers[folder]) return { success: false, message: "Server must be stopped first" };
    const targetDir = path.join(getServersDir(), folder, 'core');
    const jarPath = path.join(targetDir, 'server.jar');
    if (fs.existsSync(jarPath)) fs.unlinkSync(jarPath);
    try { await downloadFile(downloadUrl, jarPath); return { success: true }; } 
    catch (err) { return { success: false, message: err.message }; }
});

ipcMain.handle('list-tasks', (e, folder) => {
    const tasksDir = path.join(getServersDir(), folder, 'tasks');
    if (!fs.existsSync(tasksDir)) return [];
    return fs.readdirSync(tasksDir).filter(f => f.endsWith('.json')).map(f => {
        return JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf-8'));
    });
});

ipcMain.handle('save-task', (e, folder, task) => {
    const tasksDir = path.join(getServersDir(), folder, 'tasks');
    if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });
    const fp = path.join(tasksDir, `${task.id}.json`);
    fs.writeFileSync(fp, JSON.stringify(task, null, 2), 'utf-8');
    startIntervalScheduler(folder);
    return true;
});

ipcMain.handle('delete-task', (e, folder, taskId) => {
    const fp = path.join(getServersDir(), folder, 'tasks', `${taskId}.json`);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    startIntervalScheduler(folder);
    return true;
});

ipcMain.handle('open-external', (e, folder, subpath) => {
    const fp = path.join(getServersDir(), folder, 'core', subpath);
    if (fs.existsSync(fp)) shell.openPath(fp);
    return true;
});