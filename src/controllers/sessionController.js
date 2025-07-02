import axios from 'axios';
import fs from 'fs';
const botServers = JSON.parse(fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8'));
import { assignServerForUser } from '../services/loadBalancer.js';
import supabase from '../services/supabaseClient.js'; // You must create this file

// Helper to get server URL by server_id
function getServerUrl(server_id) {
  const server = botServers.find(s => s.id === server_id);
  return server ? server.url : null;
}

// Helper to find server by phoneNumber in sessions table
async function findServerIdByPhone(phoneNumber) {
  const { data, error } = await supabase
    .from('sessions')
    .select('server_id')
    .eq('phoneNumber', phoneNumber)
    .single();
  if (error || !data) return null;
  return data.server_id;
}

// Proxy user registration (handled by backend, but routed by Load Manager)
export async function handleRegister(req, res) {
  try {
    // Assign to best server
    const bestServer = await assignServerForUser();
    const serverUrl = getServerUrl(bestServer);
    if (!serverUrl) return res.status(500).json({ error: 'No available server' });

    // Forward registration to the chosen bot server
    console.log(`[REGISTER] Proxying to: ${serverUrl}`);
    const response = await axios.post(`${serverUrl}/api/auth/register`, req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
}

// Proxy login, reset-password, validate-token, etc.
export async function handleAuthAction(req, res) {
  const { action, phoneNumber } = req.params;
  try {
    // For login and registration, just pick the first healthy server
    let serverUrl = getServerUrl((await assignServerForUser()) || botServers[0].id);

    // For actions on a specific bot (restart/delete), find the server by phoneNumber
    if (phoneNumber) {
      const serverId = await findServerIdByPhone(phoneNumber);
      serverUrl = getServerUrl(serverId);
    }

    if (!serverUrl) return res.status(500).json({ error: 'No available server' });

    // Proxy the request
    console.log(`[AUTH:${action}] Proxying to: ${serverUrl}`);
    const url = phoneNumber
      ? `${serverUrl}/api/auth/${action}/${phoneNumber}`
      : `${serverUrl}/api/auth/${action}`;
    const method = req.method.toLowerCase();
    const response = await axios({ url, method, data: req.body });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: `Auth action failed: ${action}`, details: err.message });
  }
}

// Proxy session actions (start, stop, restart, etc.)
export async function handleSessionAction(req, res) {
  const { action } = req.params;
  let { phoneNumber, authId } = req.body;
  console.log(`[LM] handleSessionAction: action=${action}, phoneNumber=${phoneNumber}`);

  try {
    // 1. Try to find existing server assignment
    let serverId = await findServerIdByPhone(phoneNumber);
    console.log(`[LM] Found serverId: ${serverId} for phone: ${phoneNumber}`);

    // 2. If not found, assign a server dynamically
    if (!serverId) {
      serverId = await assignServerForUser(); // Your load balancer logic
      console.log(`[LM] Signing new serverId: ${serverId} for phone: ${phoneNumber}`);
      // Save the assignment in sessions table
      if (serverId && phoneNumber && authId) {
        await supabase.from('sessions').insert([
          { phoneNumber, authId, server_id: serverId }
        ]);
        console.log(`[LM] Assigned new server: ${serverId} for phone: ${phoneNumber}`);
      }
    }

    const serverUrl = getServerUrl(serverId);
    console.log(`[LM] Proxying to serverUrl: ${serverUrl}`);
    if (!serverUrl) return res.status(500).json({ error: 'No available server' });

    const response = await axios.post(`${serverUrl}/api/${action}`, req.body);
    res.status(response.status).json(response.data);
  } catch (err) {
  // Forward real error from bot server if available
  if (err.response && err.response.data) {
    return res.status(err.response.status).json(err.response.data);
  }
  res.status(500).json({ error: `Session action failed: ${action}`, details: err.message });
}}


// Proxy /api/user/* endpoints
export async function handleUserAction(req, res) {
  const { action, phoneNumber } = req.params;
  const { authId } = req.body;
  try {
    // Find the server by phoneNumber or authId
    let serverId = null;
    if (phoneNumber) serverId = await findServerIdByPhone(phoneNumber);
    if (!serverId && authId) {
      // Try to find any session for this authId
      const { data } = await supabase.from('sessions').select('server_id').eq('authId', authId).limit(1);
      if (data && data.length > 0) serverId = data[0].server_id;
    }
    const serverUrl = getServerUrl(serverId || botServers[0].id);
    if (!serverUrl) return res.status(500).json({ error: 'No available server' });

    // Proxy the request
    console.log(`[USER:${action}] Proxying to: ${serverUrl}`);
    const url = phoneNumber
      ? `${serverUrl}/api/user/${action}/${phoneNumber}`
      : `${serverUrl}/api/user/${action}`;
    const method = req.method.toLowerCase();
    const response = await axios({ url, method, data: req.body, params: req.query });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: `User action failed: ${action}`, details: err.message });
  }
}

// Proxy /api/admin/* endpoints
export async function handleAdminAction(req, res) {
  const { action, phoneNumber } = req.params;
  try {
    // For admin, just pick the first healthy server (or round-robin if you want)
    const serverUrl = getServerUrl((await assignServerForUser()) || botServers[0].id);
    if (!serverUrl) return res.status(500).json({ error: 'No available server' });
    console.log(`[ADMIN:${action}] Proxying to: ${serverUrl}`);
    const url = phoneNumber
      ? `${serverUrl}/api/admin/${action}/${phoneNumber}`
      : `${serverUrl}/api/admin/${action}`;
    const method = req.method.toLowerCase();
    const response = await axios({ url, method, data: req.body, params: req.query });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: `Admin action failed: ${action}`, details: err.message });
  }
}