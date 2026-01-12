const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// =======================================================
// ⚙️ CONFIGURATION
// =======================================================
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new line.Client(config);

// =======================================================
// 🚀 MAIN HANDLER
// =======================================================
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    if (!req.body || !req.body.events) return res.status(200).json({ ok: true });

    try {
        await Promise.all(req.body.events.map(event => handleEvent(event)));
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Handler Error:', err);
        res.status(500).end();
    }
}

// =======================================================
// 🎮 EVENT ROUTER
// =======================================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    const isNumberOnly = /^\d+$/.test(text);
    const isTrackCommand = text.startsWith('ติดตามคิว');

    // 1. สั่งติดตามคิว
    if (isNumberOnly || isTrackCommand) {
        return await processQueueTracking(event, userId, text, isNumberOnly);
    } 
    // 2. สั่งยกเลิก
    else if (text === 'หยุด') {
        return await processStopTracking(event, userId);
    } 
    // 3. ดูประวัติล่าสุด
    else if (text === 'ล่าสุด' || text === 'ประวัติ') {
        return await processViewHistory(event);
    } 
    // 4. เมนูหลัก
    else {
        return await sendWelcomeMenu(event);
    }
}

// =======================================================
// 🧠 BUSINESS LOGIC
// =======================================================

async function processQueueTracking(event, userId, text, isNumberOnly) {
    
    // เตรียมเลขคิว (ต้องใช้ทั้งในโหมดจริง และโหมดทดสอบ)
    let queueInput = isNumberOnly ? text : text.replace('ติดตามคิว', '').trim();
    if (!queueInput || isNaN(queueInput)) {
        return client.replyMessage(event.replyToken, {
            type: 'text', text: "❌ กรุณาระบุเลขคิวให้ถูกต้อง เช่น '4012'"
        });
    }
    const targetQueue = parseInt(queueInput);

    // ==============================================================================
    // 🔴 โซนตั้งค่าการทดสอบ (SIMULATION SWITCH)
    // ==============================================================================
    
    // 👇 แก้บรรทัดนี้: เป็น true เพื่อเทสว่าเต็ม / เป็น false เพื่อใช้งานจริง
    const SIMULATE_QUOTA_FULL = false; 
    
    // ==============================================================================

    // 1. ตรวจสอบโหมดทดสอบ หรือ โควต้าเต็มจริง
    const isRealQuotaFull = await isQuotaFull(); 

    if (SIMULATE_QUOTA_FULL || isRealQuotaFull) {
        console.log("⚠️ Quota Limit Triggered (Simulation or Real)");

        // สร้างลิ้งก์ Deep Link ไป Telegram พร้อมเลขคิว
        const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${targetQueue}`;

        return client.replyMessage(event.replyToken, {
            type: 'flex',
            altText: '⚠️ แจ้งเตือน: โควต้า LINE เต็ม',
            contents: {
                type: "bubble",
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: "⚠️", size: "4xl", align: "center" },
                        { type: "text", text: "โควต้าแจ้งเตือน LINE เต็ม", weight: "bold", size: "lg", color: "#ff3333", align: "center", margin: "md" },
                        { type: "text", text: "ระบบไม่สามารถส่งแจ้งเตือนผ่าน LINE ได้ในขณะนี้", size: "sm", color: "#555555", align: "center", margin: "md", wrap: true },
                        { type: "separator", margin: "lg" },
                        { type: "text", text: "กรุณาใช้ Telegram ฟรีและไม่มีลิมิต", size: "xs", color: "#aaaaaa", align: "center", margin: "lg" }
                    ]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                        {
                            type: "button",
                            style: "primary",
                            color: "#2481cc", // สีฟ้า Telegram
                            height: "sm",
                            // ปุ่มนี้กดแล้วไป Telegram พร้อมสั่งเริ่มงานทันที
                            action: { type: "uri", label: "👉 ย้ายไป Telegram Bot", uri: telegramDeepLink }
                        },
                        {
                            type: "button",
                            style: "secondary",
                            height: "sm",
                            action: { type: "uri", label: "ดูผ่านเว็บไซต์", uri: "https://queue-monitor.vercel.app" }
                        }
                    ]
                }
            }
        });
    }

    // --- พื้นที่ทำงานปกติ (จะทำงานต่อเมื่อโควต้าไม่เต็ม และ Simulation = false) ---

    // 2. ดึงสถานะล่าสุด
    const status = await getSmartQueueStatus(targetQueue);

    // 3. บันทึกลง DB
    const { error } = await supabase.from('line_trackers').upsert({ 
        user_id: userId, 
        tracking_queue: targetQueue 
    });

    if (error) {
        console.error("DB Error:", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ ระบบขัดข้อง กรุณาลองใหม่" });
    }

    // 4. ส่ง Flex Message ปกติ (มี 3 ปุ่ม)
    const flexMessage = generateStatusFlex(targetQueue, status);
    return client.replyMessage(event.replyToken, flexMessage);
}

async function processStopTracking(event, userId) {
    await supabase.from('line_trackers').delete().eq('user_id', userId);
    return client.replyMessage(event.replyToken, { 
        type: 'text', 
        text: '❌ ยกเลิกการติดตามเรียบร้อยแล้ว' 
    });
}

// =======================================================
// 🔄 ฟังก์ชัน: เช็คสถานะคิวของตัวเอง (แก้ใหม่)
// =======================================================
async function processViewHistory(event) {
    const userId = event.source.userId;

    try {
        // 1. หาว่า User ถือคิวอะไรอยู่
        const { data: tracker } = await supabase
            .from('line_trackers')
            .select('tracking_queue')
            .eq('user_id', userId)
            .maybeSingle();

        // ถ้าไม่ได้ติดตามคิว -> แจ้งให้ไปพิมพ์เลขคิวก่อน
        if (!tracker) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ ท่านยังไม่ได้ติดตามคิว\nกรุณาพิมพ์เลขคิวของท่านก่อน (เช่น 4012) เพื่อให้ระบบดึงประวัติได้ถูกต้องครับ"
            });
        }

        const myQueue = parseInt(tracker.tracking_queue);

        // 2. คำนวณช่วงหมวดหมู่ (เช่น 4012 -> หมวด 4000-5000)
        const seriesStart = Math.floor(myQueue / 1000) * 1000;
        const seriesEnd = seriesStart + 1000;

        // 3. ดึง 10 รายการล่าสุด *เฉพาะหมวดนั้น*
        const { data: logs } = await supabase
            .from('queue_snapshots')
            .select('current_queue, current_counter, created_at')
            .gte('current_queue', seriesStart) // มากกว่าหรือเท่ากับ 4000
            .lt('current_queue', seriesEnd)    // น้อยกว่า 5000
            .order('created_at', { ascending: false })
            .limit(10);

        if (!logs || logs.length === 0) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: `⏳ ยังไม่มีการเรียกคิวในหมวด ${seriesStart} วันนี้` 
            });
        }

        // 4. สร้าง Flex Message แบบเฉพาะเจาะจง
        const flexMessage = generateTargetedHistoryFlex(myQueue, logs);
        return client.replyMessage(event.replyToken, flexMessage);

    } catch (e) {
        console.error("History Error:", e);
        return client.replyMessage(event.replyToken, { type: 'text', text: "❌ เกิดข้อผิดพลาดในการดึงข้อมูล" });
    }
}

async function sendWelcomeMenu(event) {
    return client.replyMessage(event.replyToken, {
        type: 'flex',
        altText: 'เมนูหลัก',
        contents: {
            type: "bubble",
            hero: {
                type: "image",
                url: "https://cdn-icons-png.flaticon.com/512/3135/3135715.png",
                size: "full",
                aspectRatio: "20:13",
                aspectMode: "cover",
                backgroundColor: "#eeeeee"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "ระบบติดตามคิวที่ดิน", weight: "bold", size: "xl", color: "#1DB446" },
                    { type: "text", text: "จ.นครสวรรค์", weight: "bold", size: "md", margin: "sm" },
                    { type: "separator", margin: "md" },
                    { type: "text", text: "พิมพ์เลขคิวของท่านได้เลย", margin: "md", size: "sm", color: "#555555" },
                    { type: "text", text: "ตัวอย่าง: 4012", size: "xs", color: "#aaaaaa", margin: "xs" }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    {
                        type: "button",
                        action: { type: "message", label: "📋 ดูรายการล่าสุด", text: "ล่าสุด" },
                        style: "secondary"
                    },
                    {
                        type: "button",
                        action: { type: "uri", label: "🌐 ดูคิวสด (Web)", uri: "https://queue-monitor.vercel.app" },
                        style: "primary", color: "#1DB446"
                    }
                ]
            }
        }
    });
}

// =======================================================
// 🛠️ HELPER FUNCTIONS
// =======================================================

async function isQuotaFull() {
    try {
        const [quota, consumption] = await Promise.all([
            client.getMessageQuota(), client.getMessageQuotaConsumption()
        ]);
        return (quota.type !== 'none' && consumption.totalUsage >= quota.value);
    } catch (e) { return false; }
}

async function getSmartQueueStatus(targetQueue) {
    try {
        const seriesStart = Math.floor(targetQueue / 1000) * 1000;
        const seriesEnd = seriesStart + 1000;
        const { data: snapshots } = await supabase
            .from('queue_snapshots') 
            .select('current_queue, current_counter')
            .order('created_at', { ascending: false })
            .limit(50);

        if (snapshots && snapshots.length > 0) {
            const match = snapshots.find(item => {
                const q = parseInt(item.current_queue);
                return q >= seriesStart && q < seriesEnd;
            });
            if (match) return { queue: parseInt(match.current_queue), counter: match.current_counter || '-' };
        }
    } catch (e) { console.error("Fetch Status Error:", e); }
    return { queue: 0, counter: '-' };
}

// =======================================================
// 🎨 FLEX GENERATORS
// =======================================================

function generateStatusFlex(targetQueue, status) {
    const { queue: currentQueue, counter: currentCounter } = status;
    const telegramDeepLink = `https://t.me/NakhonsawanLandBot?start=${targetQueue}`;

    let statusText = "สถานะคิว";
    let statusColor = "#999999"; 
    let descText = "ตรวจสอบข้อมูล...";
    
    if (currentQueue > 0) {
        const diff = targetQueue - currentQueue;
        
        if (diff === 0) {
            statusText = "ถึงคิวแล้ว!";
            statusColor = "#D93025"; 
            descText = `กรุณาติดต่อช่อง ${currentCounter}`;
        } else if (diff === 1) {
            statusText = "คิวถัดไป";
            statusColor = "#F9AB00"; 
            descText = "เตรียมตัวรอเรียกได้เลย";
        } else if (diff > 1) {
            statusText = `รออีก ${diff} คิว`;
            statusColor = "#1DB446"; 
            descText = `คิวปัจจุบัน: ${currentQueue}`;
        } else if (diff < 0) {
            statusText = "คิวปัจจุบัน";
            statusColor = "#555555"; 
            descText = `ขณะนี้เรียกถึงคิว: ${currentQueue}`;
        }
    } else {
        descText = "ยังไม่มีข้อมูลการเรียกคิวหมวดนี้";
    }

    return {
        type: "flex",
        altText: `สถานะคิว ${targetQueue}`,
        contents: {
            type: "bubble",
            size: "kilo",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "บัตรคิวของคุณ", weight: "bold", color: "#aaaaaa", size: "xs" },
                    { type: "text", text: `${targetQueue}`, weight: "bold", size: "4xl", margin: "md", color: "#333333" },
                    { type: "separator", margin: "lg" },
                    {
                        type: "box",
                        layout: "vertical",
                        margin: "lg",
                        contents: [
                            { type: "text", text: statusText, weight: "bold", size: "xl", color: statusColor, align: "center" },
                            { type: "text", text: descText, size: "sm", color: "#555555", align: "center", margin: "sm" }
                        ]
                    }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                spacing: "sm",
                contents: [
                    {
                        type: "button",
                        action: { type: "uri", label: "🔔 แจ้งเตือนผ่าน Telegram", uri: telegramDeepLink },
                        style: "primary", height: "sm", color: "#2481cc"
                    },
                    {
                        type: "button",
                        action: { type: "message", label: "📋 ดูรายการล่าสุด", text: "ล่าสุด" },
                        style: "secondary", height: "sm"
                    },
                    {
                        type: "button",
                        action: { type: "uri", label: "🌐 ดูคิวสด (Web)", uri: "https://queue-monitor.vercel.app" },
                        style: "link", height: "sm"
                    }
                ]
            }
        }
    };
}

function generateTargetedHistoryFlex(myQueue, logs) {
    // คำนวณคิวที่เหลือ
    const latestQueue = parseInt(logs[0].current_queue);
    const diff = myQueue - latestQueue;

    let headerTitle = "";
    let headerColor = "#000000";
    let subTitle = "";

    if (diff > 0) {
        headerTitle = `รออีก ${diff} คิว`;
        headerColor = "#1DB446"; // เขียว
        subTitle = `คิวล่าสุด: ${latestQueue}`;
    } else if (diff === 0) {
        headerTitle = "ถึงคิวแล้ว!";
        headerColor = "#D93025"; // แดง
        subTitle = `เชิญช่อง: ${logs[0].current_counter}`;
    } else {
        headerTitle = "เลยคิวแล้ว";
        headerColor = "#555555"; // เทา
        subTitle = `คิวล่าสุดไปที่: ${latestQueue}`;
    }

    const listItems = logs.map(log => {
        const time = new Date(log.created_at).toLocaleTimeString('th-TH', { 
            timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' 
        });
        const isLatest = (log.current_queue === latestQueue);
        
        return {
            type: "box",
            layout: "horizontal",
            contents: [
                { type: "text", text: `${time}`, size: "sm", color: isLatest ? "#333333" : "#888888", flex: 2 },
                { type: "text", text: `คิว ${log.current_queue}`, size: "sm", color: "#333333", weight: isLatest ? "bold" : "regular", flex: 3 },
                { type: "text", text: `ช่อง ${log.current_counter}`, size: "sm", color: isLatest ? "#D93025" : "#1DB446", align: "end", flex: 2, weight: isLatest ? "bold" : "regular" }
            ],
            margin: "sm",
            backgroundColor: isLatest ? "#f0fdf4" : "#ffffff",
            paddingAll: isLatest ? "sm" : "none",
            cornerRadius: isLatest ? "md" : "none"
        };
    });

    return {
        type: "flex",
        altText: `เหลืออีก ${diff} คิว`,
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "box", layout: "vertical", backgroundColor: "#f7f7f7", cornerRadius: "lg", paddingAll: "lg",
                        contents: [
                            { type: "text", text: "คิวของคุณ", size: "xs", color: "#aaaaaa", align: "center" },
                            { type: "text", text: `${myQueue}`, size: "xl", weight: "bold", color: "#333333", align: "center" },
                            { type: "separator", margin: "md" },
                            { type: "text", text: headerTitle, size: "xxl", weight: "bold", color: headerColor, align: "center", margin: "md" },
                            { type: "text", text: subTitle, size: "sm", color: "#555555", align: "center", margin: "sm" }
                        ]
                    },
                    { type: "separator", margin: "lg" },
                    { type: "text", text: "ประวัติการเรียก (หมวดนี้)", weight: "bold", size: "sm", margin: "lg", color: "#aaaaaa" },
                    { type: "box", layout: "vertical", margin: "md", contents: listItems }
                ]
            },
            footer: {
                type: "box", layout: "vertical",
                contents: [{ type: "text", text: "กด 'ล่าสุด' เพื่อรีเฟรชข้อมูล", size: "xs", color: "#aaaaaa", align: "center" }]
            }
        }
    };
}


