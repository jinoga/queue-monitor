const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

// ตั้งค่า Environment Variables ใน Vercel ให้ตรงกับ Node.js ตัวหลัก
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new line.Client(config);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const events = req.body.events;
    try {
        await Promise.all(events.map(event => handleEvent(event)));
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).end();
    }
}

async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    // ==========================================
    // 1. คำสั่ง "ติดตามคิว [เลขคิว]"
    // ==========================================
    if (text.startsWith('ติดตามคิว')) {
        
        // --- A. เช็คโควต้าก่อน (ป้องกัน Bill บานปลาย) ---
        try {
            const [quota, consumption] = await Promise.all([
                client.getMessageQuota(),             
                client.getMessageQuotaConsumption()   
            ]);

            if (quota.type !== 'none' && consumption.totalUsage >= quota.value) {
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `⚠️ ขณะนี้โควต้า LINE เต็มแล้ว\nกรุณาติดตามผ่าน Telegram: https://t.me/NakhonsawanLandBot`
                });
            }
        } catch (e) { console.error("Quota Check Error", e); }
        // ---------------------------------------------

        const queueInput = text.replace('ติดตามคิว', '').trim();
        if (!queueInput || isNaN(queueInput)) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ กรุณาระบุเลขคิว เช่น 'ติดตามคิว 100'"
            });
        }
        const targetQueue = parseInt(queueInput);

        // --- B. ดึงคิวล่าสุดจาก Table 'queue_snapshots' (ที่ Node.js เป็นคนเขียน) ---
        let currentQueue = 0;
        try {
            const { data: latestLog } = await supabase
                .from('queue_snapshots') 
                .select('current_queue')
                .order('created_at', { ascending: false }) // เอาตัวล่าสุดที่ Node.js เขียนลงไป
                .limit(1)
                .single();
            
            if (latestLog) {
                currentQueue = parseInt(latestLog.current_queue);
            }
        } catch (e) { console.error("DB Fetch Error", e); }

        // --- C. บันทึกลง 'line_trackers' (เพื่อให้ Node.js มาอ่านแล้วแจ้งเตือนต่อ) ---
        try {
            const { error } = await supabase
                .from('line_trackers')
                .upsert({ 
                    user_id: userId, 
                    tracking_queue: targetQueue 
                });

            if (error) throw error;

            // --- D. ตอบกลับ (Reply Message) ---
            let replyText = `✅ บันทึกติดตามคิว ${targetQueue}`;
            
            if (currentQueue > 0) {
                replyText += `\n(คิวปัจจุบัน: ${currentQueue})`;
                
                // Logic แจ้งเตือนทันที ถ้าคิวมันถึงแล้วหรือใกล้มาก
                if (currentQueue >= targetQueue) {
                    replyText += `\n\n🚨 **ถึงคิวแล้ว/เลยคิวแล้ว**\nติดต่อเคาน์เตอร์ด่วน!`;
                } else if (targetQueue - currentQueue === 1) {
                    replyText += `\n\n⚠️ **ท่านคือคิวถัดไป**\nเตรียมตัวรอเรียกได้เลย`;
                } else {
                    replyText += `\n\n🔔 ระบบจะแจ้งเตือนเมื่อใกล้ถึงคิว`;
                }
            } else {
                replyText += `\n\n🔔 รอการอัปเดตจากระบบสักครู่...`;
            }

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: replyText
            });

        } catch (dbError) {
            console.error("Supabase Error:", dbError);
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ ระบบฐานข้อมูลขัดข้อง กรุณาลองใหม่"
            });
        }
    }

    // ==========================================
    // 2. คำสั่ง "หยุด"
    // ==========================================
    if (text === 'หยุด') {
        // ลบออกจาก line_trackers เพื่อไม่ให้ Node.js ส่ง Push มาอีก
        await supabase.from('line_trackers').delete().eq('user_id', userId);
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '❌ ยกเลิกการติดตามเรียบร้อย' 
        });
    }

    // ==========================================
    // 3. เมนูหลัก
    // ==========================================
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "🤖 ระบบติดตามคิวที่ดิน (เชื่อมต่อระบบหลัก)\n\n" +
              "🔹 พิมพ์ 'ติดตามคิว X' (เช่น ติดตามคิว 100)\n" +
              "🔹 พิมพ์ 'หยุด' เพื่อยกเลิก\n" +
              "🔹 Telegram (เรียลไทม์): https://t.me/NakhonsawanLandBot"
    });
}
