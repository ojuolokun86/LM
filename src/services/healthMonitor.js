import axios from 'axios';
import fs from 'fs';
import { notifyAdmin } from './notification.js';
const botServers = JSON.parse(fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8'));
const lastHealthState = {};
const serverStatus = {};
import supabase from './supabaseClient.js';

async function checkServer(server) {
  try {
    const res = await axios.get(`${server.url}/api/health`);
    serverStatus[server.id] = { healthy: true, load: res.data.load || 0 };
    if (lastHealthState[server.id] !== 'healthy') {
      notifyAdmin(`✅ Server "${server.id}" is back online.`);
      lastHealthState[server.id] = 'healthy';
    }
  } catch (err) {
    console.error(`[HEALTH CHECK ERROR] ${server.url}:`, err.message);
    serverStatus[server.id] = { healthy: false, load: Infinity };
    if (lastHealthState[server.id] !== 'unhealthy') {
      notifyAdmin(`❌ Server "${server.id}" is DOWN!`);
      lastHealthState[server.id] = 'unhealthy';

      // Find a healthy server to failover to
      const healthyServerId = Object.entries(serverStatus)
        .find(([id, info]) => id !== server.id && info.healthy)?.[0];
      if (healthyServerId) {
        await reassignSessionsFromDownServer(server.id, healthyServerId);
      }
    }
  }
}
async function reassignSessionsFromDownServer(downServerId, healthyServerId) {
  // Update all sessions in Supabase from downServerId to healthyServerId
  const { error } = await supabase
    .from('sessions')
    .update({ server_id: healthyServerId })
    .eq('server_id', downServerId);

  if (error) {
    console.error(`❌ Failed to reassign sessions from ${downServerId} to ${healthyServerId}:`, error.message);
    return;
  }
  console.log(`✅ Reassigned sessions from ${downServerId} to ${healthyServerId}`);

  // Optionally, trigger the healthy server to reload sessions
  const botServers = JSON.parse(fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8'));
  const healthyServer = botServers.find(s => s.id === healthyServerId);
  if (healthyServer) {
    try {
      await axios.post(`${healthyServer.url}/api/admin/reload-sessions`);
      console.log(`✅ Triggered ${healthyServerId} to reload sessions`);
    } catch (err) {
      console.error(`❌ Failed to trigger reload on ${healthyServerId}:`, err.message);
    }
  }
}


// Check all servers every 30 seconds
export async function checkAllServers() {
  await Promise.all(botServers.map(checkServer));
}

export async function getServerStatus() {
  return serverStatus;
}

// Start periodic health checks
setInterval(checkAllServers, 20000);
checkAllServers();