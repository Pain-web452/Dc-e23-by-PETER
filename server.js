const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Render के लिए पोर्ट कॉन्फ़िगरेशन
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let activeInterval = null;
let botRunning = false;

// होम रूट
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// बॉट चालू करने का API
app.post('/api/start', async (req, res) => {
    if (botRunning) {
        return res.json({ success: false, message: "बॉट पहले से ही चल रहा है!" });
    }

    const { primaryCookie, targetUid, delay, messages } = req.body;
    let index = 0;
    botRunning = true;

    console.log(`[START] Target UID: ${targetUid} | Delay: ${delay}s`);

    // 24/7 बैकग्राउंड मैसेजिंग लूप
    activeInterval = setInterval(async () => {
        if (!botRunning) return;

        const currentMsg = messages[index];
        
        try {
            // फेसबुक mbasic मैसेंजर स्क्रैपिंग / सेंडिंग एंडपॉइंट के लिए रिक्वेस्ट स्ट्रक्चर
            // नोट: फेसबुक के कड़े सुरक्षा नियमों के कारण यहाँ कुकीज़ और टोकन को हेडर में पास करना होता है।
            console.log(`Sending to ${targetUid}: ${currentMsg}`);
            
            // यह ब्लॉक फेसबुक के बैकएंड एंडपॉइंट पर मैसेज पोस्ट करने की कोशिश करता है
            /*
            await axios.post(`https://facebook.com`, 
                `body=${encodeURIComponent(currentMsg)}&tids=cid.c.${targetUid}`, 
                {
                    headers: {
                        'Cookie': primaryCookie,
                        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
                    }
                }
            );
            */
        } catch (err) {
            console.log("मैसेज भेजने में समस्या आई (चेक करें कुकी एक्सपायर तो नहीं हुई):", err.message);
        }

        // अगले मैसेज पर जाने के लिए लूप बढ़ाना
        index = (index + 1) % messages.length;

    }, delay * 1000);

    res.json({ success: true });
});

// बॉट रोकने का API
app.post('/api/stop', (req, res) => {
    if (activeInterval) {
        clearInterval(activeInterval);
        activeInterval = null;
    }
    botRunning = false;
    console.log("[STOP] बॉट रोक दिया गया है।");
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`सर्वर चालू है: http://localhost:${PORT}`);
});
