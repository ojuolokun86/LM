import { getServerStatus } from './healthMonitor.js';
import fs from 'fs';
const botServers = JSON.parse(fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8'));

// Assigns user to the healthiest/least-loaded server (equal share, no VPS priority)
export async function assignServerForUser() {
  const status = await getServerStatus();

  // Filter all healthy servers that are not overloaded
  const healthyServers = botServers.filter(s => {
    const serverStatus = status[s.id];
    return serverStatus?.healthy && (serverStatus.load || 0) < (s.maxLoad || 1);
  });

  if (!healthyServers.length) return null;

  // Sort by current load (ascending)
  healthyServers.sort((a, b) => (status[a.id].load || 0) - (status[b.id].load || 0));

  // Assign to the least-loaded healthy server
  const assignedServer = healthyServers[0].id;
  console.log(`[LOAD BALANCER] Assigned server: ${assignedServer}`);
  return assignedServer;
}