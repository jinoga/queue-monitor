const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const client = new line.Client(config);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // Fail-safe: ป้องกัน error กรณีไม่มี events ส่งมา
    if (!req.body || !req.body.events) return res.status(200).json({ ok: true });

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
    // รับเฉพาะข้อความที่เป็น Text
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    const userId = event.source.userId;
    const text = event.message.text.trim();

    // =======================================================
    // 1. คำสั่ง "ติดตามคิว [เลขคิว]"
    // =======================================================
    if (text.startsWith('ติดตามคิว')) {
        
        // --- ส่วนที่ 1: เช็คโควต้า (คงเดิม) ---
        try {
            const [quota, consumption] = await Promise.all([
                client.getMessageQuota(),             
                client.getMessageQuotaConsumption()   
            ]);

            if (quota.type !== 'none' && consumption.totalUsage >= quota.value) {
                console.warn(`Line Quota Reached: Used ${consumption.totalUsage}/${quota.value}`);
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `⚠️ ขณะนี้โควต้าการแจ้งเตือนผ่าน LINE เต็มแล้ว (Limit Reached)\n\n` +
                          `ระบบจะไม่สามารถส่งแจ้งเตือนเมื่อถึงคิวได้ในขณะนี้\n` +
                          `กรุณาใช้ช่องทางสำรอง ฟรีและไม่มีลิมิต:\n\n` +
                          `👉 Telegram Bot: https://t.me/NakhonsawanLandBot\n` +
                          `🌐 เว็บไซต์: https://queue-monitor.vercel.app`
                });
            }
        } catch (quotaError) {
            console.error("Error checking quota:", quotaError);
        }
        // ----------------------------------------

        const queueInput = text.replace('ติดตามคิว', '').trim();
        
        // ตรวจสอบว่าเป็นตัวเลขหรือไม่
        if (!queueInput || isNaN(queueInput)) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ กรุณาระบุหมายเลขคิวเป็นตัวเลข เช่น 'ติดตามคิว 100'"
            });
        }

        const targetQueue = parseInt(queueInput);

        // ==================================================================
        // 🔴 ส่วนที่ 2: ดึงมาเยอะๆ แล้วกรองด้วย JS (เพื่อความแม่นยำสูงสุด)
        // ==================================================================
        let currentQueue = 0;
        let currentCounter = '-'; 

        try {
            // คำนวณช่วงหมวดคิว (เช่น 4012 -> 4000 ถึง 5000)
            const seriesStart = Math.floor(targetQueue / 1000) * 1000;
            const seriesEnd = seriesStart + 1000;

            // 1. ดึงข้อมูลล่าสุดมา 50 รายการ
            const { data: snapshots } = await supabase
                .from('queue_snapshots') 
                .select('current_queue, current_counter')
                .order('created_at', { ascending: false })
                .limit(50); 

            if (snapshots && snapshots.length > 0) {
                // 2. ใช้ JavaScript วนหาตัวแรก ที่เลขคิว "ตรงกับหมวด" ของเรา
                const match = snapshots.find(item => {
                    const q = parseInt(item.current_queue);
                    return q >= seriesStart && q < seriesEnd;
                });

                if (match) {
                    currentQueue = parseInt(match.current_queue);
                    currentCounter = match.current_counter || '-';
                }
            }
        } catch (e) {
            console.error("Failed to fetch current queue:", e);
        }
        // ------------------------------------------------------------------

        try {
            // บันทึกลง Supabase
            const { error } = await supabase
                .from('line_trackers')
                .upsert({ 
                    user_id: userId, 
                    tracking_queue: targetQueue 
                });

            if (error) throw error;

            // --- ส่วนที่ 3: แสดงผล (ปรับแก้ตามที่ขอ) ---
            let replyText = `✅ เริ่มติดตามคิว ${targetQueue} ให้คุณแล้ว`;

            if (currentQueue > 0) {
                const diff = targetQueue - currentQueue;
                
                replyText += `\n(ขณะนี้คิวหมวดนี้เรียกถึง: ${currentQueue})`;

                // ⚠️ แก้ไขตรงนี้: เปลี่ยนข้อความกรณีเลยคิว
                if (diff < 0) {
                    replyText += `\n\n🚨 **เกินคิวของท่านแล้ว**\nกรุณาติดต่อช่องบริการ ${currentCounter}`;
                } 
                else if (diff === 0) {
                    // ถึงคิวพอดี
                    replyText += `\n\n🚨 **ถึงคิวของท่านแล้ว!**\nกรุณาไปที่ช่องบริการ ${currentCounter}`;
                } 
                else if (diff === 1) {
                    // คิวถัดไป
                    replyText += `\n\n⚠️ **เตรียมตัว! ท่านคือคิวถัดไป**\nกรุณารอเรียกที่หน้าช่องบริการ`;
                } 
                else {
                    // ยังไม่ถึง
                    replyText += `\n\n⏳ เหลืออีก ${diff} คิวจะถึงท่าน\nระบบจะแจ้งเตือนเมื่อใกล้ถึงคิวครับ`;
                }
            } else {
                // หาไม่เจอใน 50 รายการล่าสุด หรือยังไม่มีคิวหมวดนี้
                replyText += `\n\n🔔 ระบบจะแจ้งเตือน 2 ครั้ง:\n` +
                             `1️⃣ เมื่อถึงคิวที่ ${targetQueue - 1} (แจ้งเตือนล่วงหน้า)\n` +
                             `2️⃣ เมื่อถึงคิวที่ ${targetQueue} (แจ้งเตือนให้รับบริการ)`;
            }

            // Footer
            replyText += `\n\n💡 ติดตามสด/ไม่จำกัด: https://t.me/NakhonsawanLandBot\n` +
                         `🌐 เว็บไซต์: https://queue-monitor.vercel.app`;

            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: replyText
            });

        } catch (dbError) {
            console.error("Supabase Error:", dbError);
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: "❌ เกิดข้อผิดพลาดในระบบฐานข้อมูล กรุณาลองใหม่"
            });
        }
    }

    // =======================================================
    // 2. คำสั่ง "หยุด"
    // =======================================================
    if (text === 'หยุด') {
        await supabase.from('line_trackers').delete().eq('user_id', userId);
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '❌ ยกเลิกการติดตามคิวทั้งหมดเรียบร้อยแล้ว' 
        });
    }

    // =======================================================
    // 3. ข้อความอื่นๆ (เมนูแนะนำ)
    // =======================================================
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "🤖 ระบบติดตามคิวที่ดิน จ.นครสวรรค์\n\n" +
              "🔹 พิมพ์ 'ติดตามคิว (ตามด้วยเลขคิวของท่าน)' เพื่อรับแจ้งเตือนเมื่อใกล้ถึงคิว เช่น ติดตามคิว 1001\n" +
              "🔹 พิมพ์ 'หยุด' เพื่อยกเลิกการติดตาม\n" +
              "🔹 ติดตามสด/ไม่จำกัด: https://t.me/NakhonsawanLandBot\n" +
              "🔹 เว็บไซต์: https://queue-monitor.vercel.app"
       
    });
}
