const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let activeTasks = {};

// फेसबुक मैसेंजर पर डायरेक्ट HTTP सेंड फ़ंक्शन
async function sendDirectMessage(cookies, targetId, text) {
    try {
        const headers = {
            'cookie': cookies,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': '*/*',
            'content-type': 'application/x-www-form-urlencoded'
        };

        // FB Graph Lite / Basic API Endpoint Wrapper
        const fbUrl = `https://facebook.com{targetId}/messages`;
        
        // अल्टरनेटिव मोबाइल वेब स्क्रैप फॉलवैक विधि
        await axios.post(`https://facebook.com`, 
            new URLSearchParams({
                'body': text,
                'tids': `cid.g.${targetId}`
            }).toString(), 
            { headers }
        );
        return true;
    } catch (err) {
        console.error("Message send failure hook:", err.message);
        return false;
    }
}

app.post('/api/start-bot', (req, res) => {
    const { primaryCookies, backupCookies, targetUid, prefixName, delay, messages } = req.body;

    const msgArray = messages.split('\n').map(msg => msg.trim()).filter(msg => msg !== "");
    if (msgArray.length === 0) {
        return res.status(400).json({ error: "Message content cannot be empty!" });
    }

    const taskId = "TASK-" + Math.floor(1000 + Math.random() * 9000);
    let msgIndex = 0;
    
    activeTasks[taskId] = {
        status: "Running",
        primary: primaryCookies,
        backup: backupCookies || primaryCookies,
        intervalId: null
    };

    const delayMs = parseInt(delay) * 1000 || 10000;

    const sendLoop = async () => {
        if (!activeTasks[taskId] || activeTasks[taskId].status === "Stopped") {
            if(activeTasks[taskId]?.intervalId) clearInterval(activeTasks[taskId].intervalId);
            return;
        }

        let rawMsg = msgArray[msgIndex];
        let finalMsg = prefixName ? `${prefixName} ${rawMsg}` : rawMsg;
        
        // प्राइमरी कुकी से भेजने का प्रयास करें
        let success = await sendDirectMessage(activeTasks[taskId].primary, targetUid, finalMsg);
        
        // अगर प्राइमरी फेल हो जाए तो बैकअप कुकी का इस्तेमाल करें
        if (!success && activeTasks[taskId].backup) {
            console.log(`[${taskId}] Primary cookie failed. Switching to backup.`);
            success = await sendDirectMessage(activeTasks[taskId].backup, targetUid, finalMsg);
        }

        if(success) {
            console.log(`[${taskId}] Success -> ${finalMsg}`);
        }

        msgIndex = (msgIndex + 1) % msgArray.length;
    };

    sendLoop();
    activeTasks[taskId].intervalId = setInterval(sendLoop, delayMs);

    res.json({ success: true, taskId: taskId, message: "Task initialized successfully!" });
});

app.post('/api/stop-task', (req, res) => {
    const { taskId } = req.body;
    if (activeTasks[taskId]) {
        clearInterval(activeTasks[taskId].intervalId);
        activeTasks[taskId].status = "Stopped";
        delete activeTasks[taskId];
        return res.json({ success: true, message: `Task ${taskId} has been deleted/stopped.` });
    }
    res.status(404).json({ error: "Task ID not found." });
});

app.post('/api/update-cookies', (req, res) => {
    const { taskId, newPrimary, newBackup } = req.body;
    if (activeTasks[taskId]) {
        if(newPrimary) activeTasks[taskId].primary = newPrimary;
        if(newBackup) activeTasks[taskId].backup = newBackup;
        return res.json({ success: true, message: `Cookies for ${taskId} updated live.` });
    }
    res.status(404).json({ error: "Active Task ID not found." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Premium Web Server listening on port ${PORT}`);
});
