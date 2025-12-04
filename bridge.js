// index.js - Modpack Bridge (Node.js)
// รันบนเครื่องผู้เล่น แล้วให้ Next.js Web เรียก http://localhost:35555

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 35555;

// -----------------------
//  Device token & config
// -----------------------

const getConfigPath = () => {
    const homedir = os.homedir();
    // โฟลเดอร์ config สำหรับ Bridge
    const configDir =
        process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), 'lexten-minecraft-bridge')
            : path.join(homedir, '.config', 'lexten-bridge');

    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    return path.join(configDir, 'device_token.json');
};

function getOrCreateDeviceToken() {
    const configPath = getConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            const json = JSON.parse(data);
            if (json.token) return json.token;
        }
    } catch (e) {
        // ignore
    }

    const newToken = crypto.randomUUID();
    try {
        fs.writeFileSync(
            configPath,
            JSON.stringify({ token: newToken, created_at: new Date().toISOString() }, null, 2),
            'utf8'
        );
    } catch (e) {
        // ignore
    }
    return newToken;
}

const DEVICE_TOKEN = getOrCreateDeviceToken();

// -----------------------
//  Helpers
// -----------------------

function getMinecraftPath() {
    const homedir = os.homedir();
    switch (process.platform) {
        case 'win32':
            // ส่วนใหญ่ APPDATA จะชี้ไปที่ Roaming อยู่แล้ว
            return path.join(process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming'), '.minecraft');
        case 'darwin':
            return path.join(homedir, 'Library', 'Application Support', 'minecraft');
        case 'linux':
            return path.join(homedir, '.minecraft');
        default:
            throw new Error('Unsupported OS');
    }
}

// สแกน instance ทั้งหมด (default + โฟลเดอร์ใน .minecraft/versions)
function detectInstances() {
    const instances = [];
    let mcPath;

    try {
        mcPath = getMinecraftPath();
    } catch (e) {
        return instances;
    }

    // default
    instances.push({
        id: 'default',
        name: '.minecraft (Default)',
        path: mcPath,
        kind: 'default'
    });

    const versionsDir = path.join(mcPath, 'versions');
    if (fs.existsSync(versionsDir)) {
        const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
        entries
            .filter((d) => d.isDirectory())
            .forEach((d) => {
                const folderName = d.name;
                const safeId = `ver_${folderName.replace(/[^\w\-]+/g, '_')}`;

                instances.push({
                    id: safeId,
                    name: `${folderName} (Version Folder)`,
                    path: path.join(versionsDir, folderName), // ตรงนี้จะเป็น root สำหรับ mods/config/resourcepacks
                    kind: 'version',
                    versionFolder: folderName
                });
            });
    }

    return instances;
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ดาวน์โหลดไฟล์จาก HTTP/HTTPS ไปยัง path ที่กำหนด
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const dir = path.dirname(destPath);
        ensureDir(dir);

        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https:') ? https : http;

        const request = client.get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close(() => {
                    fs.unlink(destPath, () => { });
                });
                return reject(new Error(`Download failed with status code: ${response.statusCode}`));
            }

            response.pipe(file);
            file.on('finish', () => file.close(resolve));
        });

        request.on('error', (err) => {
            file.close(() => {
                fs.unlink(destPath, () => { });
            });
            reject(err);
        });
    });
}

// -----------------------
//  Middleware
// -----------------------
app.use(cors({ origin: '*' }));
app.use(express.json());

// -----------------------
//  Endpoints
// -----------------------

// 1) Status — ให้ Web เอาไปโชว์ + รายชื่อ Instances
app.get('/status', (req, res) => {
    let mcPath = '';
    try {
        mcPath = getMinecraftPath();
    } catch (e) {
        // ถ้า OS แปลกมาก ก็ปล่อยว่างไป
    }

    const instances = detectInstances();

    res.json({
        status: 'ready',
        version: '1.1.0',
        token: DEVICE_TOKEN,
        os: process.platform,
        mcPath,
        instances
    });
});

// 2) Install แบบ zip (รุ่นเก่า – ถ้ายังอยากใช้)
//    POST /install  { url, mode, autoTerminate }
//    ยังเผื่อไว้ให้ ถ้า UI เก่าเรียกอยู่
app.post('/install', async (req, res) => {
    const { url, mode, autoTerminate } = req.body || {};

    try {
        const mcPath = getMinecraftPath();
        ensureDir(mcPath);

        const tempFile = path.join(mcPath, 'temp_modpack.zip');

        // ดาวน์โหลด zip
        await downloadFile(url, tempFile);

        // ถ้า full mode ลบโฟลเดอร์เดิมก่อน
        if (mode === 'full') {
            ['mods', 'config', 'resourcepacks'].forEach((folder) => {
                const target = path.join(mcPath, folder);
                if (fs.existsSync(target)) {
                    try {
                        fs.rmSync(target, { recursive: true, force: true });
                    } catch (e) { }
                }
            });
        }

        // แตก zip (ต้องติดตั้ง adm-zip ถ้าจะใช้ block นี้)
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        zip.extractAllTo(mcPath, true);

        fs.unlinkSync(tempFile);

        res.json({ success: true });

        if (autoTerminate) {
            setTimeout(() => process.exit(0), 1000);
        }
    } catch (err) {
        console.error('INSTALL (zip) ERROR:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3) Install แบบ per-file (ใช้กับ UI ใหม่)
//    POST /install-files
//    body:
//    {
//      mode: "patch" | "full",
//      autoTerminate: true/false,
//      instanceId: "default" | "ver_xxx",
//      gameDir: "C:\\Users\\..\\AppData\\Roaming\\.minecraft\\versions\\xxx",  // optional
//      items: [
//        { type: "mod" | "resourcepack" | "config", url: "https://...", fileName: "xxx.jar" },
//        ...
//      ]
//    }
app.post('/install-files', async (req, res) => {
    const { mode, autoTerminate, instanceId, gameDir, items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No items to install.'
        });
    }

    try {
        let rootDir = gameDir;

        if (!rootDir) {
            const instances = detectInstances();
            let target =
                instances.find((i) => i.id === instanceId) ||
                instances.find((i) => i.id === 'default') ||
                instances[0];

            if (!target) {
                // fallback สุดท้าย
                rootDir = getMinecraftPath();
            } else {
                rootDir = target.path;
            }
        }

        ensureDir(rootDir);

        // ถ้า full mode ลบของเก่าก่อน (เฉพาะ instance นี้)
        if (mode === 'full') {
            ['mods', 'config', 'resourcepacks'].forEach((folder) => {
                const target = path.join(rootDir, folder);
                if (fs.existsSync(target)) {
                    try {
                        fs.rmSync(target, { recursive: true, force: true });
                    } catch (e) { }
                }
            });
        }

        // ดาวน์โหลดทีละไฟล์
        for (const item of items) {
            if (!item || !item.url || !item.fileName) continue;

            const type = item.type || 'mod';
            let subFolder = 'mods';
            if (type === 'resourcepack') subFolder = 'resourcepacks';
            else if (type === 'config') subFolder = 'config';

            const folderPath = path.join(rootDir, subFolder);
            const destPath = path.join(folderPath, item.fileName);

            console.log(`[INSTALL] ${type} -> ${destPath}`);
            await downloadFile(item.url, destPath);
        }

        res.json({ success: true });

        if (autoTerminate) {
            setTimeout(() => process.exit(0), 1000);
        }
    } catch (err) {
        console.error('INSTALL-FILES ERROR:', err);
        res.status(500).json({
            success: false,
            error: err.message || 'Unknown error'
        });
    }
});

// -----------------------
//  Start server
// -----------------------
app.listen(PORT, () => {
    console.log(`Modpack Bridge listening on http://localhost:${PORT}`);
});
