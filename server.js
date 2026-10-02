const express = require('express');
const login = require('@distfx/fb-chat-api'); // नई वर्किंग लाइब्रेरी यहाँ लिंक की गई है
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let activeTasks = {};

app.post('/api/start-bot', (req, res) => {
    const { primaryCookies, targetUid, delay, messages } = req.body;

    let credentials;
    try {
        credentials = { appState: JSON.parse(primaryCookies) };
    } catch (e) {
        return res.status(400).json({ error: "कुकीज़ (AppState) का फॉर्मेट सही JSON होना चाहिए!" });
    }

    const msgArray = messages.split('\n').map(msg => msg.trim()).filter(msg => msg !== "");
    if (msgArray.length === 0) {
        return res.status(400).json({ error: "मैसेज फ़ाइल खाली है!" });
    }

    const taskId = "TASK-" + Math.floor(1000 + Math.random() * 9000);
    let msgIndex = 0;

    const options = {
        forceLogin: true,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };

    login(credentials, options, (err, api) => {
        if (err) {
            console.error("Login Error Details:", err);
            return res.status(500).json({ error: "फेसबुक लॉगिन फेल! कृपया अपने फेसबुक ऐप पर जाकर 'Was this you?' नोटिफिकेशन में 'Yes' पर क्लिक करें।" });
        }

        activeTasks[taskId] = { status: "Running", intervalId: null };
        const delayMs = parseInt(delay) * 1000 || 10000;

        const sendLoop = () => {
            if (!activeTasks[taskId] || activeTasks[taskId].status === "Stopped") {
                if(activeTasks[taskId]?.intervalId) clearInterval(activeTasks[taskId].intervalId);
                return;
            }

            const currentMsg = msgArray[msgIndex];
            api.sendMessage({ body: currentMsg }, targetUid, (msgErr) => {
                if (msgErr) {
                    console.log(`[${taskId}] एरर:`, msgErr);
                } else {
                    console.log(`[${taskId}] भेजा गया: ${currentMsg}`);
                }
            });

            msgIndex = (msgIndex + 1) % msgArray.length;
        };

        sendLoop();
        activeTasks[taskId].intervalId = setInterval(sendLoop, delayMs);
        res.json({ success: true, taskId: taskId, message: `बॉट फ़ाइल के ${msgArray.length} मैसेजेस के साथ चालू हो गया है!` });
    });
});

app.post('/api/stop-task', (req, res) => {
    const { taskId } = req.body;
    if (activeTasks[taskId]) {
        clearInterval(activeTasks[taskId].intervalId);
        activeTasks[taskId].status = "Stopped";
        delete activeTasks[taskId];
        return res.json({ success: true, message: `टास्क ID ${taskId} को सफलतापूर्वक रोक दिया गया है।` });
    }
    res.status(404).json({ error: "यह टास्क ID नहीं मिली।" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`सर्वर पोर्ट ${PORT} पर लाइव है।`);
});
