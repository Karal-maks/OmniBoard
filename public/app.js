// Initialize Socket.io connection for Node.js backend
const socket = io();

socket.on('connect', () => {
    console.log('✅ Success: Connected to WebSocket server!');
});

socket.on('connect_error', (err) => {
    console.error('❌ WebSocket Connection Error:', err);
});

socket.on('db-update', (data) => {
    console.log('📥 Received db-update packet:', data);

    if (!data) return;

    // 1. Update Top Metrics Cards safely
    const pgCount = document.getElementById('pgCount');
    const pgLatVal = document.getElementById('pgLatVal');
    const mongoCount = document.getElementById('mongoCount');
    const mongoLatVal = document.getElementById('mongoLatVal');
    const activeClients = document.getElementById('activeClients');
    const throughput = document.getElementById('throughput');

    if (pgCount) pgCount.innerText = data.postgresLogsCount ?? 0;
    if (pgLatVal) pgLatVal.innerText = `Latency: ${data.postgresLatency ?? 0} ms`;
    
    if (mongoCount) mongoCount.innerText = data.mongoLogsCount ?? 0;
    if (mongoLatVal) mongoLatVal.innerText = `Latency: ${data.mongoLatency ?? 0} ms`;
    
    if (activeClients) activeClients.innerText = data.activeConnections ?? 1;
    if (throughput) throughput.innerText = data.totalThroughput ?? 0;

    // 2. Update Health Status Badges
    const pgHealth = document.getElementById('pgHealth');
    const mongoHealth = document.getElementById('mongoHealth');
    if (pgHealth) pgHealth.innerText = data.postgresStatus || 'Healthy';
    if (mongoHealth) mongoHealth.innerText = data.mongoDbStatus || 'Healthy';

    // 3. Populate PostgreSQL Table
    const pgTbody = document.querySelector('#pgTable tbody');
    if (pgTbody && data.recentPostgres && data.recentPostgres.length > 0) {
        pgTbody.innerHTML = data.recentPostgres.map(row => `
            <tr>
                <td>${row.id}</td>
                <td>${row.event_name}</td>
                <td style="color: #9ca3af;">${row.metadata || 'N/A'}</td>
                <td>${new Date(row.created_at).toLocaleTimeString()}</td>
            </tr>
        `).join('');
    }

    // 4. Populate MongoDB Table
    const mongoTbody = document.querySelector('#mongoTable tbody');
    if (mongoTbody && data.recentMongo && data.recentMongo.length > 0) {
        mongoTbody.innerHTML = data.recentMongo.map(doc => `
            <tr>
                <td title="${doc._id}">${doc._id.substring(0, 8)}...</td>
                <td>${doc.eventName}</td>
                <td style="color: #c084fc; font-family: monospace; font-size: 0.75rem;">${JSON.stringify(doc.payload)}</td>
                <td>${new Date(doc.createdAt).toLocaleTimeString()}</td>
            </tr>
        `).join('');
    }
});

// Manual transaction dispatch button
const runCheckBtn = document.getElementById('runCheckBtn');
if (runCheckBtn) {
    runCheckBtn.addEventListener('click', async () => {
        runCheckBtn.innerText = 'Dispatching...';
        try {
            await fetch('/api/system-check');
        } catch (error) {
            console.error('Manual transaction failed:', error);
        } finally {
            runCheckBtn.innerText = '⚡ Execute Manual Transaction';
        }
    });
}