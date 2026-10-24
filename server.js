const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const { Rcon } = require('rcon-client');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MC_DIR = '/opt/minecraft';
const LOG_FILE = path.join(MC_DIR, 'logs/latest.log');

// Sesuaikan password RCON sesuai di file server.properties
const RCON_CONFIG = {
    host: '127.0.0.1',
    port: 25575,
    password: 'admin123'
};

app.use(express.json());
app.use(express.static('public'));

// 1. Control Server (Start / Stop / Restart)
app.post('/api/control', (req, res) => {
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

// 2. RCON Command (Kirim Perintah Console)
app.post('/api/command', async (req, res) => {
    try {
        const rcon = await Rcon.connect(RCON_CONFIG);
        const response = await rcon.send(req.body.command);
        await rcon.end();
        res.json({ output: response });
    } catch (e) {
        res.status(500).json({ error: 'RCON Error: ' + e.message });
    }
});

// 3. File Manager (List, Read, Save)
app.get('/api/files', (req, res) => {
    const targetDir = req.query.dir ? path.join(MC_DIR, req.query.dir) : MC_DIR;
    if (!targetDir.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.readdir(targetDir, { withFileTypes: true }, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        const list = files.map(f => ({
            name: f.name,
            isDirectory: f.isDirectory(),
            relPath: path.relative(MC_DIR, path.join(targetDir, f.name))
        }));
        res.json(list);
    });
});

app.get('/api/files/read', (req, res) => {
    const filePath = path.join(MC_DIR, req.query.file);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: err.message });
        res.type('text/plain').send(data);
    });
});

app.post('/api/files/save', (req, res) => {
    const filePath = path.join(MC_DIR, req.body.file);
    if (!filePath.startsWith(MC_DIR)) return res.status(403).json({ error: 'Akses ditolak' });

    fs.writeFile(filePath, req.body.content, 'utf8', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'File berhasil disimpan' });
    });
});

// 4. Stream Log Real-time via WebSocket
wss.on('connection', (ws) => {
    const tail = spawn('tail', ['-F', '-n', '100', LOG_FILE]);

    tail.stdout.on('data', (data) => ws.send(data.toString()));
    tail.stderr.on('data', (data) => ws.send('[LOG ERR] ' + data.toString()));

    ws.on('close', () => tail.kill());
});

server.listen(3000, () => console.log('Dashboard berjalan di http://localhost:3000'));