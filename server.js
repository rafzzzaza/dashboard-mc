const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const { Rcon } = require('rcon-client');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const MC_DIR = '/opt/minecraft';
const LOG_FILE = path.join(MC_DIR, 'logs/latest.log');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

const RCON_CONFIG = {
    host: '127.0.0.1',
    port: 25575,
    password: 'admin123'
};

const sessionParser = session({
    secret: 'kawansmp-dashboard-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(express.json());
app.use(sessionParser);
app.use(express.static('public'));

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.status(401).json({ error: 'Sesi habis atau belum login' });
}

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const targetDir = req.query.dir ? path.join(MC_DIR, req.query.dir) : MC_DIR;
            if (!targetDir.startsWith(MC_DIR)) return cb(new Error('Akses ditolak'));
            cb(null, targetDir);
        },
        filename: (req, file, cb) => cb(null, file.originalname)
    })
});

// AUTH
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.authenticated = true;
        res.json({ message: 'Login berhasil' });
    } else {
        res.status(401).json({ error: 'Username atau password salah' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: 'Logout berhasil' });
});

app.get('/api/auth/check', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// CONTROL & RCON
app.post('/api/control', requireAuth, (req, res) => {
    const { action } = req.body;
    if (['start', 'stop', 'restart'].includes(action)) {
        exec(`systemctl ${action} minecraft`, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: `Server berhasil di-${action}` });
        });
    } else {
        res.status(400).json({ error: 'Aksi tidak valid' });
    }
});

app.post('/api/command', requireAuth, async (req, res) => {
    try {
        const rcon = await Rcon.connect(RCON_CONFIG);
        const response = await rcon.send(req.body.command);
        await rcon.end();
        res.json({ output: response });
    } catch (e) {
        res.status(500).json({ error: 'RCON Error: ' + e.message });
    }
});

// FILE MANAGER
app.get('/api/files', requireAuth, (req, res) => {
    const targetDir = req.query.dir ? path.join(MC_DIR, req.query.dir) : MC_DIR;
    if (!targetDir.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.readdir(targetDir, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = files.map(f => {
            const fullPath = path.join(targetDir, f.name);
            let size = 0;
            try { if (!f.isDirectory()) size = fs.statSync(fullPath).size; } catch (e) { }
            return {
                name: f.name,
                isDirectory: f.isDirectory(),
                size,
                relPath: path.relative(MC_DIR, fullPath)
            };
        });
        res.json(list);
    });
});

app.get('/api/files/read', requireAuth, (req, res) => {
    const filePath = path.join(MC_DIR, req.query.file);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: err.message });
        res.type('text/plain').send(data);
    });
});

app.post('/api/files/save', requireAuth, (req, res) => {
    const filePath = path.join(MC_DIR, req.body.file);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.writeFile(filePath, req.body.content, 'utf8', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'File berhasil disimpan' });
    });
});

app.post('/api/files/create-file', requireAuth, (req, res) => {
    const { dir, filename } = req.body;
    const filePath = path.join(MC_DIR, dir || '', filename);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.writeFile(filePath, '', { flag: 'wx' }, (err) => {
        if (err) return res.status(500).json({ error: 'File sudah ada atau gagal dibuat' });
        res.json({ message: 'File baru berhasil dibuat' });
    });
});

app.post('/api/files/create-folder', requireAuth, (req, res) => {
    const { dir, foldername } = req.body;
    const folderPath = path.join(MC_DIR, dir || '', foldername);
    if (!folderPath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.mkdir(folderPath, { recursive: true }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Folder baru berhasil dibuat' });
    });
});

app.post('/api/files/delete', requireAuth, (req, res) => {
    const filePath = path.join(MC_DIR, req.body.relPath);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.rm(filePath, { recursive: true, force: true }, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Item berhasil dihapus' });
    });
});

app.post('/api/files/rename', requireAuth, (req, res) => {
    const oldPath = path.join(MC_DIR, req.body.oldRelPath);
    const newPath = path.join(path.dirname(oldPath), req.body.newName);
    if (!oldPath.startsWith(MC_DIR) || !newPath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.rename(oldPath, newPath, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Berhasil diubah nama' });
    });
});

app.get('/api/files/download', requireAuth, (req, res) => {
    const filePath = path.join(MC_DIR, req.query.file);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });
    res.download(filePath);
});

app.post('/api/files/upload', requireAuth, upload.array('files'), (req, res) => {
    res.json({ message: 'Upload file berhasil' });
});

app.post('/api/files/zip', requireAuth, (req, res) => {
    const { relPath, zipName } = req.body;
    const targetPath = path.join(MC_DIR, relPath);
    const outputZip = path.join(path.dirname(targetPath), zipName || 'archive.zip');

    if (!targetPath.startsWith(MC_DIR) || !outputZip.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    exec(`cd "${path.dirname(targetPath)}" && zip -r "${outputZip}" "${path.basename(targetPath)}"`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Kompresi Zip berhasil' });
    });
});

app.post('/api/files/unzip', requireAuth, (req, res) => {
    const { relPath } = req.body;
    const zipFilePath = path.join(MC_DIR, relPath);
    const destDir = path.dirname(zipFilePath);

    if (!zipFilePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    exec(`unzip -o "${zipFilePath}" -d "${destDir}"`, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Unzip berhasil' });
    });
});

// WEBSOCKET
server.on('upgrade', (request, socket, head) => {
    sessionParser(request, {}, () => {
        if (!request.session || !request.session.authenticated) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });
});

wss.on('connection', (ws) => {
    const tail = spawn('tail', ['-F', '-n', '100', LOG_FILE]);
    tail.stdout.on('data', (data) => ws.send(data.toString()));
    tail.stderr.on('data', (data) => ws.send('[LOG ERR] ' + data.toString()));
    ws.on('close', () => tail.kill());
});

server.listen(3000, () => console.log('Dashboard running at http://localhost:3000'));