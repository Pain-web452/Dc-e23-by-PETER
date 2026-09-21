const express = require('express');
const multer = require('multer');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/start-bot', upload.single('txt_file'), async (req, res) => {
    const { cookies, target_id, e2ee_pin, prefix, delay } = req.body;
    
    if (!req.file) {
        return res.status(400).send("कृपया एक .txt फाइल अपलोड करें जिसमें मैसेजेस हों।");
    }

    // .txt फाइल से मैसेजेस रीड करना
    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const messages = fileContent.split('\n').map(msg => msg.trim()).filter(msg => msg.length > 0);
    
    // काम के बाद टेम्परेरी फाइल डिलीट करना
    fs.unlinkSync(filePath);

    res.send("<h1>बॉट बैकग्राउंड में शुरू हो गया है! टर्मिनल (Console) लॉग्स चेक करें।</h1>");

    // बैकग्राउंड में ब्राउज़र ऑटोमेशन शुरू करना
    try {
        console.log("[*] ब्राउज़र लॉन्च किया जा रहा है...");
        const browser = await puppeteer.launch({ 
            headless: true, // बैकग्राउंड में चलाने के लिए true, देखने के लिए false कर सकते हैं
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // 1. कुकीज़ को पार्स करके ब्राउज़र में सेट करना
        console.log("[*] कुकीज़ सेट की जा रही हैं...");
        const cookieArray = cookies.split(';').map(pair => {
            const parts = pair.split('=');
            if(parts.length >= 2) {
                return {
                    name: parts[0].trim(),
                    value: parts.slice(1).join('=').trim(),
                    domain: '.facebook.com',
                    path: '/'
                };
            }
        }).filter(Boolean);

        await page.setCookie(...cookieArray);

        // 2. सीधे टारगेट चैट थ्रेड पर जाना
        const chatUrl = `https://facebook.com{target_id}`;
        console.log(`[*] चैट थ्रेड पर जा रहे हैं: ${chatUrl}`);
        await page.goto(chatUrl, { waitUntil: 'networkidle2' });

        // 3. E2EE पिन हैंडल करना (यदि स्क्रीन पर दिखाई दे)
        if (e2ee_pin) {
            console.log("[*] E2EE पिन इनपुट बॉक्स की तलाश की जा रही है...");
            try {
                // मैसेंजर के एंड-टू-एंड पिन बॉक्स का संभावित सेलेक्टर (यह समय के साथ बदल सकता है)
                const pinSelector = 'input[type="password"]'; 
                await page.waitForSelector(pinSelector, { timeout: 15000 });
                console.log("[*] E2EE पिन दर्ज किया जा रहा है...");
                await page.type(pinSelector, e2ee_pin);
                await page.keyboard.press('Enter');
                await page.waitForTimeout(5000); // लोड होने का समय दें
            } catch (err) {
                console.log("[!] E2EE पिन बॉक्स नहीं दिखा या पहले से अनलॉक है। आगे बढ़ रहे हैं...");
            }
        }

        // 4. लूप चलाकर फाइल के मैसेजेस भेजना
        for (let i = 0; i < messages.length; i++) {
            let currentMsg = messages[i];
            if (prefix) {
                currentMsg = `${prefix} ${currentMsg}`;
            }

            console.log(`[+] संदेश भेज रहे हैं (${i + 1}/${messages.length}): ${currentMsg}`);

            try {
                // मैसेंजर का मैसेज बॉक्स सेलेक्टर (रोल-बेस्ड या डिविजन ढूंढना)
                const msgBoxSelector = 'div[role="textbox"]';
                await page.waitForSelector(msgBoxSelector, { timeout: 10000 });
                await page.focus(msgBoxSelector);
                
                // बिल्कुल इंसानी तरीके से टाइप करना
                await page.keyboard.type(currentMsg);
                await page.keyboard.press('Enter');
                
                console.log(`[✓] संदेश सफलतापूर्वक भेजा गया। अगला संदेश ${delay} सेकंड बाद जाएगा...`);
            } catch (sendErr) {
                console.error("[X] मैसेज बॉक्स नहीं मिला या भेजने में त्रुटि आई:", sendErr.message);
            }

            // यूजर द्वारा सेट किया गया डिले (Delay) रोकना
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }

        console.log("[*] सभी मैसेजेस भेज दिए गए हैं। ब्राउज़र बंद हो रहा है।");
        await browser.close();

    } catch (globalErr) {
        console.error("[Critical Error]: बॉट क्रैश हो गया ->", globalErr.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`서वर http://localhost:${PORT} पर रन कर रहा है`));
