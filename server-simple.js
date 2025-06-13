// server-simple.js - Enhanced Error Handling Version
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ตัวแปรเก็บข้อมูล
let latestQueueData = null;
let counterHistory = {};
let isConnected = false;
let connectionAttempts = 0;
let maxRetries = 3;

// กำหนด URL ของระบบคิว
const QUEUE_URL = 'https://elands.dol.go.th/QueueOnlineServer/queue/294';
const STREAM_URL = 'https://elands.dol.go.th/QueueOnlineServer/service/queue_stream/294';

// ฟังก์ชันสร้างข้อมูลจำลอง (สำหรับทดสอบ)
function createMockData() {
    const mockQueues = [];
    const startNum = Math.floor(Math.random() * 1000) + 2000;
    
    for (let i = 0; i < 10; i++) {
        mockQueues.push({
            queueNo: String(startNum + i).padStart(4, '0'),
            customerName: `Customer ${i + 1}`,
            serviceType: 'บริการทั่วไป'
        });
    }
    
    return {
        currentQueue: {
            queueNo: String(startNum - 1).padStart(4, '0'),
            counterNo: '1',
            customerName: 'Current Customer',
            serviceType: 'บริการทั่วไป'
        },
        queue: mockQueues,
        totalWaiting: mockQueues.length,
        fetchedAt: new Date().toISOString(),
        source: 'mock_data'
    };
}

// ฟังก์ชันเชื่อมต่อ SSE (ปรับปรุงแล้ว)
function connectToSSE() {
    return new Promise((resolve, reject) => {
        if (connectionAttempts >= maxRetries) {
            console.log('🔄 หยุดพยายามเชื่อมต่อ SSE (ใช้ Mock Data แทน)');
            latestQueueData = createMockData();
            updateCounterHistory(latestQueueData);
            reject(new Error('Max retries reached'));
            return;
        }
        
        connectionAttempts++;
        console.log(`🔗 เชื่อมต่อ SSE (ครั้งที่ ${connectionAttempts}):`, STREAM_URL);
        
        const https = require('https');
        const url = require('url');
        
        const parsedUrl = url.parse(STREAM_URL);
        
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.path,
            method: 'GET',
            headers: {
                'Accept': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Connection': 'keep-alive'
            },
            timeout: 15000 // เพิ่ม timeout
        };

        const sseRequest = https.request(options, (res) => {
            console.log('📡 SSE Connected, Status:', res.statusCode);
            
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            isConnected = true;
            connectionAttempts = 0; // รีเซ็ตเมื่อเชื่อมต่อสำเร็จ
            resolve();

            let buffer = '';

            res.on('data', (chunk) => {
                buffer += chunk.toString();
                
                const lines = buffer.split('\n');
                buffer = lines.pop();

                lines.forEach(line => {
                    if (line.startsWith('data:')) {
                        try {
                            const jsonStr = line.substring(5);
                            const sseData = JSON.parse(jsonStr);
                            
                            if (sseData.manageListQueue) {
                                const queueData = JSON.parse(sseData.manageListQueue);
                                
                                latestQueueData = {
                                    ...queueData,
                                    fetchedAt: new Date().toISOString(),
                                    source: 'sse_stream'
                                };
                                
                                updateCounterHistory(latestQueueData);
                                
                                console.log('📊 Updated queue data:', {
                                    currentQueue: latestQueueData.currentQueue?.queueNo,
                                    counter: latestQueueData.currentQueue?.counterNo,
                                    waitingQueues: latestQueueData.queue?.length || 0
                                });
                            }
                        } catch (parseError) {
                            console.error('❌ Parse Error:', parseError.message);
                        }
                    }
                });
            });

            res.on('end', () => {
                console.log('📡 SSE Connection ended');
                isConnected = false;
                setTimeout(() => connectToSSE().catch(handleSSEError), 10000);
            });

            res.on('error', (error) => {
                console.error('❌ SSE Error:', error.message);
                isConnected = false;
                setTimeout(() => connectToSSE().catch(handleSSEError), 10000);
            });
        });

        sseRequest.on('error', (error) => {
            console.error('❌ Request Error:', error.message);
            isConnected = false;
            reject(error);
        });

        sseRequest.setTimeout(15000, () => {
            console.log('⏰ SSE Timeout');
            sseRequest.destroy();
            isConnected = false;
            setTimeout(() => connectToSSE().catch(handleSSEError), 10000);
        });

        sseRequest.end();
    });
}

// ฟังก์ชันจัดการ SSE Error
function handleSSEError(error) {
    console.log('⚠️ SSE Error, switching to fallback mode');
    
    // ใช้ Mock Data เมื่อเชื่อมต่อไม่ได้
    if (!latestQueueData) {
        latestQueueData = createMockData();
        updateCounterHistory(latestQueueData);
        console.log('🔄 Using Mock Data for testing');
    }
}

// อัพเดตประวัติช่องบริการ
function updateCounterHistory(queueData) {
    const currentQueue = queueData.currentQueue;
    if (!currentQueue) return;
    
    const counterNo = currentQueue.counterNo;
    const queueNo = currentQueue.queueNo;
    
    if (!counterHistory[counterNo]) {
        counterHistory[counterNo] = {
            current: null,
            completed: []
        };
    }
    
    const history = counterHistory[counterNo];
    
    if (history.current && history.current !== queueNo) {
        history.completed.unshift({
            queueNo: history.current,
            completedAt: new Date().toLocaleTimeString('th-TH')
        });
        
        if (history.completed.length > 3) {
            history.completed = history.completed.slice(0, 3);
        }
    }
    
    history.current = queueNo;
}

// ฟังก์ชันดึงข้อมูลแบบ HTTP fallback (ปรับปรุงแล้ว)
async function fetchQueueDataHTTP() {
    try {
        console.log('🔗 Fallback: ดึงข้อมูลจาก HTML page');
        
        const response = await axios.get(QUEUE_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 15000 // เพิ่ม timeout
        });

        const $ = cheerio.load(response.data);
        const scripts = $('script');
        
        let queueData = null;
        
        scripts.each((index, element) => {
            const scriptContent = $(element).html();
            if (scriptContent && scriptContent.includes('queueOnlineDataFirst')) {
                const match = scriptContent.match(/var queueOnlineDataFirst = '(.+?)';/);
                if (match) {
                    try {
                        const jsonStr = match[1].replace(/&quot;/g, '"');
                        queueData = JSON.parse(jsonStr);
                    } catch (parseError) {
                        console.error('❌ Parse Error:', parseError.message);
                    }
                }
            }
        });

        if (queueData) {
            latestQueueData = {
                ...queueData,
                fetchedAt: new Date().toISOString(),
                source: 'html_fallback'
            };
            
            updateCounterHistory(latestQueueData);
            return latestQueueData;
        } else {
            throw new Error('ไม่พบข้อมูลในหน้าเว็บ');
        }

    } catch (error) {
        console.error('❌ HTTP Fallback Error:', error.message);
        
        // สร้างข้อมูลจำลองเมื่อ HTTP ล้มเหลว
        if (!latestQueueData) {
            console.log('🔄 Creating Mock Data for fallback');
            latestQueueData = createMockData();
            updateCounterHistory(latestQueueData);
        }
        
        return latestQueueData;
    }
}

// API Routes

// ดึงข้อมูลคิวปัจจุบัน (ปรับปรุงแล้ว)
app.get('/api/queue-data', async (req, res) => {
    try {
        let data = latestQueueData;
        
        if (!data) {
            data = await fetchQueueDataHTTP();
        }
        
        res.json({
            success: true,
            data: data,
            counterHistory: counterHistory,
            connected: isConnected,
            timestamp: new Date().toISOString(),
            serverStatus: {
                connectionAttempts: connectionAttempts,
                usingMockData: data?.source === 'mock_data',
                fallbackMode: !isConnected
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            connected: false,
            serverStatus: {
                connectionAttempts: connectionAttempts,
                fallbackMode: true
            }
        });
    }
});

// ดึงสถานะช่องบริการ
app.get('/api/counter-status', (req, res) => {
    res.json({
        success: true,
        counterHistory: counterHistory,
        timestamp: new Date().toISOString()
    });
});

// สถานะระบบ (ปรับปรุงแล้ว)
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: {
            connected: isConnected,
            lastUpdate: latestQueueData?.fetchedAt || null,
            uptime: process.uptime(),
            counters: Object.keys(counterHistory).length,
            server: 'Queue Monitor v1.1 - Enhanced',
            connectionAttempts: connectionAttempts,
            usingMockData: latestQueueData?.source === 'mock_data',
            fallbackMode: !isConnected,
            dataSource: latestQueueData?.source || 'none'
        }
    });
});

// เสิร์ฟหน้าเว็บหลัก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// สำหรับ health check (ปรับปรุงแล้ว)
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        connected: isConnected,
        hasData: !!latestQueueData,
        dataSource: latestQueueData?.source || 'none'
    });
});

// Mock Data Endpoint (สำหรับทดสอบ)
app.get('/api/mock-data', (req, res) => {
    const mockData = createMockData();
    res.json({
        success: true,
        data: mockData,
        message: 'Mock data for testing purposes'
    });
});

// เริ่มต้น server
async function startServer() {
    try {
        app.listen(PORT, () => {
            console.log('🚀 Server เริ่มทำงานแล้ว! (Enhanced Version)');
            console.log(`📡 URL: http://localhost:${PORT}`);
            console.log(`🌐 Production URL จะได้รับจาก hosting provider`);
            console.log('');
            console.log('📋 API Endpoints:');
            console.log('  GET  /api/queue-data      - ดึงข้อมูลคิวและช่องบริการ');
            console.log('  GET  /api/counter-status  - สถานะช่องบริการ');
            console.log('  GET  /api/status          - สถานะระบบ (รายละเอียด)');
            console.log('  GET  /api/mock-data       - ข้อมูลจำลอง (สำหรับทดสอบ)');
            console.log('  GET  /health              - Health check');
            console.log('');
            console.log('🔧 Enhanced Features:');
            console.log('  ✅ Mock Data Fallback');
            console.log('  ✅ Better Error Handling');
            console.log('  ✅ Connection Retry Logic');
            console.log('  ✅ Detailed Status Monitoring');
        });
        
        // เริ่มต้น SSE connection
        console.log('🔍 เริ่มต้น SSE connection...');
        try {
            await connectToSSE();
            console.log('✅ SSE connection สำเร็จ!');
        } catch (error) {
            console.log('⚠️ SSE connection ล้มเหลว, ใช้ fallback mode');
            console.log('   Error:', error.message);
            
            // ลองใช้ HTTP fallback
            try {
                await fetchQueueDataHTTP();
                console.log('✅ HTTP fallback สำเร็จ!');
            } catch (fallbackError) {
                console.log('⚠️ HTTP fallback ล้มเหลว, ใช้ Mock Data');
                console.log('   Error:', fallbackError.message);
                latestQueueData = createMockData();
                updateCounterHistory(latestQueueData);
                console.log('✅ Mock Data พร้อมใช้งาน!');
            }
        }
        
        // Polling สำรอง (ปรับปรุงแล้ว)
        setInterval(async () => {
            if (!isConnected) {
                try {
                    await fetchQueueDataHTTP();
                } catch (error) {
                    // ถ้า HTTP ล้มเหลว ใช้ Mock Data
                    if (!latestQueueData || (Date.now() - new Date(latestQueueData.fetchedAt).getTime()) > 60000) {
                        latestQueueData = createMockData();
                        updateCounterHistory(latestQueueData);
                        console.log('🔄 Updated Mock Data');
                    }
                }
            }
        }, 15000); // ทุก 15 วินาที
        
    } catch (error) {
        console.error('❌ ข้อผิดพลาดในการเริ่มต้นเซิร์ฟเวอร์:', error.message);
        process.exit(1);
    }
}

// เริ่มต้น
startServer();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 กำลังปิดเซิร์ฟเวอร์...');
    console.log('✅ ปิดระบบเรียบร้อย');
    process.exit(0);
});

module.exports = app;
