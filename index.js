import baileys from '@whiskeysockets/baileys';
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = baileys;
import axios from 'axios';
import pino from 'pino';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const qrcode = require('qrcode-terminal');

const WEBHOOK_URL    = process.env.WEBHOOK_URL;    // https://support.alanbazan.com.mx/api/webhooks/baileys
const WEBHOOK_TOKEN  = process.env.WEBHOOK_TOKEN;  // token secreto
const ACCOUNT_NAME   = process.env.ACCOUNT_NAME || 'default';
const AUTH_DIR       = process.env.AUTH_DIR || './auth';

if (!WEBHOOK_URL || !WEBHOOK_TOKEN) {
    console.error('Missing WEBHOOK_URL or WEBHOOK_TOKEN env vars');
    process.exit(1);
}

const logger = pino({ level: 'silent' });

async function sendToServixia(senderPhone, senderName, preview) {
    try {
        await axios.post(WEBHOOK_URL, {
            account:      ACCOUNT_NAME,
            sender_phone: senderPhone,
            sender_name:  senderName,
            preview:      preview?.substring(0, 500),
            received_at:  new Date().toISOString(),
        }, {
            headers: { 'X-Webhook-Token': WEBHOOK_TOKEN },
            timeout: 8000,
        });
        console.log(`[${new Date().toISOString()}] ✓ Notificado: ${senderName || senderPhone}`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] ✗ Webhook error: ${err.message}`);
    }
}

async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: false,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            console.log('\n📱 Escanea este QR con WhatsApp (Dispositivos vinculados → Vincular dispositivo):\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log(`[${new Date().toISOString()}] ✅ Conectado a WhatsApp (cuenta: ${ACCOUNT_NAME})`);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`[${new Date().toISOString()}] Desconectado (código: ${code}). Reconectar: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(connect, 5000);
            } else {
                console.error('Sesión cerrada. Borra el directorio auth/ y vuelve a escanear el QR.');
                process.exit(1);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            // Ignorar mensajes propios
            if (msg.key.fromMe) continue;
            // Ignorar mensajes de grupos
            if (msg.key.remoteJid?.endsWith('@g.us')) continue;

            const senderPhone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') ?? '';
            const senderName  = msg.pushName ?? '';
            const preview     = msg.message?.conversation
                             ?? msg.message?.extendedTextMessage?.text
                             ?? msg.message?.imageMessage?.caption
                             ?? '[archivo]';

            await sendToServixia(senderPhone, senderName, preview);
        }
    });
}

connect();
