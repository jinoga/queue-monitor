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

    // Fail-safe: ป้องกันกรณีไม่มี events ส่งมา
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

    // 1. คำสั่ง "ติดตามคิว [เลขคิว]"
    if (text.startsWith('ติดตามคิว')) {
        
        // --- ส่วนที่ 1: เช็คโควต้าก่อนดำเนินการ ---
        try {
            const [quota, consumption] = await Promise.all([
                client.getMessageQuota(),             
                client.getMessageQuotaConsumption()   
            ]);

            if (quota.type !== 'none' && consumption.totalUsage >= quota.value) {
                console.warn(`Line Quota Reached: Used ${consumption.totalUsage}/${quota.value}`);
                return client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `⚠️ ขณะนี้โควต้าการแจ้งเตือนผ่าน LINE เต็มแล้ว\n\n` +
                          `ระบบจะไม่สามารถส่งแจ้งเตือนเมื่อถึงคิวได้ในขณะนี้\n` +
                          `กรุณาใช้ช่องทางสำรอง ฟรีและไม่มีลิมิต:\n` +
                          `👉 Telegram Bot: https://t.me/NakhonsawanLandBot`
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

        // --- ส่วนที่ 2: ดึงคิวปัจจุบันจาก DB (ให้ตรงกับ Node.js Main Program) ---
        let currentQueue = 0;
        let currentCounter = '-';

        try {
            // ⚠️ ใช้ตาราง 'queue_snapshots' ตาม Node.js Worker ของคุณ
            const { data: statusData } = await supabase
                .from('queue_snapshots') 
                .select('current_queue, current_counter') 
                .order('created_at', { ascending: false }) // เอาข้อมูลล่าสุด
                .limit(1)
                .single();
            
            if (statusData) {
                currentQueue = parseInt(statusData.current_queue); // แปลงเป็นตัวเลขให้ชัวร์
                currentCounter = statusData.current_counter;
            }
        } catch (e) {
            console.error("Failed to fetch current queue:", e);
        }
        // ----------------------------------------

        try {
            // บันทึกลง Supabase
            const { error } = await supabase
                .from('line_trackers')
                .upsert({ 
                    user_id: userId, 
                    tracking_queue: targetQueue 
                });

            if (error) throw error;

            // --- ส่วนที่ 3 (ปรับปรุง): Logic เปรียบเทียบที่แม่นยำ (Consistency Check) ---
            let replyText = `✅ เริ่มติดตามคิว ${targetQueue} ให้คุณแล้ว`;

            if (currentQueue > 0) {
                const diff = targetQueue - currentQueue; // หาผลต่าง
                replyText += `\n(ล่าสุดถึงคิว: ${currentQueue} | ช่อง ${currentCounter})`;

                if (diff < 0) {
                    // กรณี diff ติดลบ = เลยคิวไปแล้ว (เช่น ปัจจุบัน 105 แต่ตามคิว 100)
                    replyText += `\n\n🚨 **เลยคิวของท่านไปแล้วครับ!**\n(ผ่านไป ${Math.abs(diff)} คิว)\nกรุณาติดต่อเจ้าหน้าที่ที่ช่องบริการทันที`;
                } 
                else if (diff === 0) {
                    // กรณี diff เป็น 0 = เรียกพอดี
                    replyText += `\n\n🚨 **ถึงคิวของท่านแล้ว!**\nเชิญที่ช่องบริการ ${currentCounter} โดยด่วนครับ`;
                } 
                else if (diff === 1) {
                    // กรณี diff เป็น 1 = คิวถัดไป
                    replyText += `\n\n⚠️ **เตรียมตัว! ท่านคือคิวถัดไป**\nกรุณารอเรียกที่หน้าช่องบริการ`;
                } 
                else if (diff <= 10) {
                     // เหลือไม่เกิน 10 คิว
                     replyText += `\n\n⏳ อีก ${diff} คิวจะถึงท่าน\nระบบจะแจ้งเตือนเมื่อใกล้ถึงครับ`;
                } 
                else {
                    // เหลือเยอะ
                    replyText += `\n\n⏳ อีก ${diff} คิวจะถึงท่าน\nนั่งรอก่อนได้เลย ระบบจะแจ้งเตือนเมื่อถึงคิวที่ ${targetQueue - 1} ครับ`;
                }
            } else {
                // กรณีไม่มีข้อมูลคิวในระบบ (เช่น เช้าตรู่ หรือ Database ว่าง)
                replyText += `\n\n⏳ ระบบกำลังรอข้อมูลคิวแรก...\nเราจะแจ้งเตือนทันทีที่มีการเรียกคิวครับ`;
            }

            // Footer
            replyText += `\n\n💡 ติดตามสด: https://t.me/NakhonsawanLandBot\n` +
                         `🌐 เว็บไซต์: https://queue-monitor.vercel.app`;

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

    // 2. คำสั่ง "หยุด"
    if (text === 'หยุด') {
        await supabase.from('line_trackers').delete().eq('user_id', userId);
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: '❌ ยกเลิกการติดตามคิวทั้งหมดเรียบร้อยแล้ว' 
        });
    }

    // 3. ข้อความอื่นๆ (เมนูแนะนำ)
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: "🤖 ระบบติดตามคิวที่ดิน จ.นครสวรรค์\n\n" +
              "🔹 พิมพ์ 'ติดตามคิว (เลขคิว)' เช่น ติดตามคิว 100\n" +
              "🔹 พิมพ์ 'หยุด' เพื่อยกเลิก\n" +
              "🔹 Telegram: https://t.me/NakhonsawanLandBot"
    });
}
