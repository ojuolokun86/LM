import { WebSocketServer } from 'ws';
import fs from 'fs';
const botServers = JSON.parse(fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8'));
import supabase from '../services/supabaseClient.js';

// Helper to get server URL by server_id
function getServerUrl(server_id) {
  const server = botServers.find(s => s.id === server_id);
  return server ? server.url : null;
}

// Helper to find server_id by phoneNumber
async function findServerIdByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from('sessions')
    .select('server_id')
    .eq('phoneNumber', phoneNumber)
    .single();
  if (error || !data) return null;
  return data.server_id;
}

// Main function to attach WebSocket proxy to your Express server
export function attachWsProxy(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (client, req) => {
    // Expect frontend to send a JSON message with { phoneNumber }
    client.once('message', async (msg) => {
      let phoneNumber;
      try {
        const data = JSON.parse(msg);
        phoneNumber = data.phoneNumber;
      } catch {
        client.send(JSON.stringify({ error: 'Invalid message format. Expected JSON with phoneNumber.' }));
        client.close();
        return;
      }

      // Find which backend server handles this phoneNumber
      const serverId = await findServerIdByPhone(phoneNumber);
      const serverUrl = getServerUrl(serverId);
      if (!serverUrl) {
        client.send(JSON.stringify({ error: 'No backend server found for this session.' }));
        client.close();
        return;
      }

      // Connect to the backend bot server's WebSocket (assume /ws endpoint)
      const backendWsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
      const backend = new WebSocket(backendWsUrl);

      // Forward messages from backend to frontend
      backend.on('message', (data) => {
        client.send(data);
      });

      // Forward messages from frontend to backend (if needed)
      client.on('message', (msg) => {
        backend.readyState === backend.OPEN && backend.send(msg);
      });

      // Handle close events
      const cleanup = () => {
        try { backend.close(); } catch {}
        try { client.close(); } catch {}
      };
      backend.on('close', cleanup);
      backend.on('error', cleanup);
      client.on('close', cleanup);
      client.on('error', cleanup);
    });
  });

  console.log('✅ WebSocket proxy attached at /ws');
}