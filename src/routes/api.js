import express from 'express';
import { getServerStatus } from '../services/healthMonitor.js';
import supabase from '../services/supabaseClient.js';
import axios from 'axios';
import fs from 'fs';
import {
  handleRegister,
  handleAuthAction,
  handleSessionAction,
  handleUserAction,
  handleAdminAction
} from '../controllers/sessionController.js';


const router = express.Router();

// Utility: Get all healthy bot servers
function getHealthyBotServers(status, botServers) {
  const healthyIds = Object.entries(status)
    .filter(([_, info]) => info.healthy)
    .map(([id]) => id);
  return botServers.filter(server => healthyIds.includes(server.id));
}

// Auth endpoints

router.get('/admin/server-status', async (req, res) => {
  console.log('🔍 [admin] Checking server status...');
  try {
    const status = await getServerStatus();
    console.log('🚀Server status for admin:', status);
    res.json({ success: true, status });
  } catch (error) {
    console.error('☠️Error in /admin/server-status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
router.get('/admin/servers', async (req, res) => {
  console.log('🤖 [admin] Fetching all bot servers...');
  try {
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = getHealthyBotServers(status, botServers);
    // Make sure to return both id and name
    res.json({
      servers: healthyServers.map(s => ({
        id: s.id,
        name: s.name || s.id   // fallback to id if name is missing
      }))
    });
  } catch (error) {
    res.status(500).json({ servers: [], message: error.message });
    console.error('☠️Error in /api/admin/servers:', error);
  }
});

// --- 1. USER: Unified bot info for a user ---
router.get('/user/bot-info', async (req, res) => {
  const { authId } = req.query;
   console.log(`🔍 [user] Fetching bot info for user...${authId}`);
  if (!authId) return res.status(400).json({ message: 'Missing authId' });

  try {
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = getHealthyBotServers(status, botServers);

    // Fetch bots from all healthy servers
    const results = await Promise.all(
      healthyServers.map(async server => {
        try {
          console.log(`Fetching bots from server: ${server.id}`);
          const { data } = await axios.get(`${server.url}/api/user/bot-info`, { params: { authId } });
          console.log(`✅ Fetched ${data.bots.length} bots from server ${server.id}`);
          return data.bots || [];
        } catch {
          return [];
        }
      })
    );

    // Flatten, filter for this user, and add metrics if available
    const allBots = results.flat()
  .filter(bot => String(bot.authId) === String(authId))
  .map(bot => ({
    phoneNumber: bot.phoneNumber,
    status: bot.status || 'Inactive',
    ram: bot.ram || 'N/A',
    rom: bot.rom || 'N/A',
    uptime: bot.uptime || 'N/A',
    lastActive: bot.lastActive || 'N/A',
    version: bot.version || 'N/A',
    memoryUsage: bot.memoryUsage || 'N/A',
    cpuUsage: bot.cpuUsage || 'N/A',
  }));

    res.json({ bots: allBots });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.delete('/admin/users', async (req, res) => {
  try {
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = botServers.filter(server => status[server.id]?.healthy);

    // Send DELETE to all healthy servers
    const results = await Promise.all(
      healthyServers.map(async server => {
        
        try {
          console.log(`Deleting users on server: ${server.id}`);
          const { data } = await axios.delete(`${server.url}/api/admin/users`);
          return { server: server.id, ...data };
        } catch (err) {
          return { server: server.id, error: err.message };
        }
      })
    );

    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Switch a user's server
router.post('/admin/switch-server', async (req, res) => {
  const { phoneNumber, newServerId } = req.body;
  if (!phoneNumber || !newServerId) return res.status(400).json({ success: false, message: 'Missing params' });
  const { error } = await supabase
    .from('sessions')
    .update({ server_id: newServerId })
    .eq('phoneNumber', phoneNumber);
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json({ success: true, message: 'Server switched successfully.' });
});

router.get('/admin/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');
  if (error) return res.status(500).json({ message: error.message });
  res.json({ users: data });
});

// --- 2. ADMIN: All bots from all servers, with server info ---
router.get('/admin/bots-status', async (req, res) => {
  console.log('🔍 [admin] Fetching all bots from all servers...');
    try {
        const status = await getServerStatus();
        const botServers = JSON.parse(
            fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
        );
        const healthyServers = getHealthyBotServers(status, botServers);

        // Fetch all-bots from all healthy servers
        const results = await Promise.all(
            healthyServers.map(async server => {
                try {
                    const { data } = await axios.get(`${server.url}/api/admin/all-bots`);
                    console.log(`✅ Fetched ${data.bots.length} bots from server ${server.id}`);
                    // Attach server id to each bot
                    return (data.bots || []).map(bot => ({
                        ...bot,
                        server: server.id
                    }));
                } catch {
                    return [];
                }
            })
        );

        const allBots = results.flat();
        res.json({ bots: allBots });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// --- 3. ADMIN: All users, merged with live status and metrics ---
router.get('/admin/users-info', async (req, res) => {
  try {
    // Fetch all users from user_auth
    const { data: users, error: userError } = await supabase
      .from('user_auth')
      .select('email, auth_id, subscription_status');
    if (userError) {
      console.error('❌ Error fetching users:', userError.message);
      return res.status(500).json({ message: 'Failed to fetch users.' });
    }

    // Fetch all tokens (subscription info)
    const { data: tokens, error: tokenError } = await supabase
      .from('subscription_tokens')
      .select('user_auth_id, expiration_date, subscription_level');
    if (tokenError) {
      console.error('❌ Error fetching tokens:', tokenError.message);
      return res.status(500).json({ message: 'Failed to fetch tokens.' });
    }

    // Fetch all bots from all servers for live status/metrics
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = getHealthyBotServers(status, botServers);

    const botResults = await Promise.all(
      healthyServers.map(async server => {
        try {
          const { data } = await axios.get(`${server.url}/api/admin/bots`);
          return (data.bots || []).map(bot => ({
            ...bot,
            server: server.id,
            memoryUsage: bot.memoryUsage || 'N/A',
            cpuUsage: bot.cpuUsage || 'N/A',
          }));
        } catch {
          return [];
        }
      })
    );
    const allBots = botResults.flat();

    // Map tokens by auth_id for quick lookup
    const tokenMap = {};
    tokens.forEach(token => {
      tokenMap[token.user_auth_id] = token;
    });

    // Attach daysLeft, subscription_level, and live bot info to each user
    const usersWithSubscription = users.map(user => {
      const token = tokenMap[user.auth_id];
      let daysLeft = 'N/A';
      let subscriptionLevel = user.subscription_status || 'N/A';
      if (token && token.expiration_date) {
        const expiration = new Date(token.expiration_date);
        const now = new Date();
        daysLeft = Math.max(0, Math.ceil((expiration - now) / (1000 * 60 * 60 * 24)));
        subscriptionLevel = token.subscription_level;
      }
      // Attach bots for this user
      const bots = allBots.filter(bot => bot.authId === user.auth_id);
      return {
        ...user,
        subscription_level: subscriptionLevel,
        days_left: daysLeft,
        bots,
      };
    });

    res.status(200).json({ users: usersWithSubscription });
  } catch (err) {
    res.status(500).json({ message: 'Unexpected error occurred.' });
  }
});

// Get memory usage for all users
router.get('/admin/users/memory-usage', async (req, res) => {
  try {
    const status = await getServerStatus();
    const healthyServers = Object.entries(status)
      .filter(([_, info]) => info.healthy)
      .map(([id]) => id);

    // Get botServers config
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );

    // Fetch memory usage from each healthy server
    const results = await Promise.all(
      botServers
        .filter(server => healthyServers.includes(server.id))
        .map(async server => {
          try {
            // Adjust the endpoint path as needed
            const { data } = await axios.get(`${server.url}/api/admin/users/memory-usage`);
            return data.memoryUsage || [];
          } catch (err) {
            return [];
          }
        })
    );

    // Flatten and merge all results
    const memoryUsage = results.flat();

    res.json({ memoryUsage });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get all complaints
router.get('/admin/complaints', async (req, res) => {
  const { data, error } = await supabase.from('complaints').select('*');
  if (error) return res.status(500).json({ message: error.message });
  res.json({ complaints: data });
});

// Mark complaint as read (delete)
router.delete('/admin/complaints/:timestamp', async (req, res) => {
  const { timestamp } = req.params;
  const { error } = await supabase.from('complaints').delete().eq('timestamp', timestamp);
  if (error) return res.status(500).json({ message: error.message });
  res.json({ success: true });
});

// Proxy activity log
router.get('/user/activity-log', async (req, res) => {
  console.log('🔍 [user] Fetching activity log for user...');
  const { authId } = req.query;
  if (!authId) return res.status(400).json({ message: 'Missing authId' });

  try {
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = botServers.filter(server => status[server.id]?.healthy);
    if (!healthyServers.length) return res.status(503).json({ message: 'No healthy bot servers' });

    // Fetch activity logs from all healthy servers
    const results = await Promise.all(
      healthyServers.map(async server => {
        try {
          const { data } = await axios.get(`${server.url}/api/user/activity-log`, { params: { authId } });
          console.log(`✅ Fetched activity log from server: ${server.id}`);
          return data.activities || [];
        } catch (err) {
          return [];
        }
      })
    );

    // Merge all activity logs and sort by timestamp (descending)
    const allActivities = results.flat().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({ activities: allActivities });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Proxy analytics
router.get('/user/analytics', async (req, res) => {
  const { authId } = req.query;
  if (!authId) return res.status(400).json({ message: 'Missing authId' });

  try {
    const status = await getServerStatus();
    const botServers = JSON.parse(
      fs.readFileSync(new URL('../config/botServers.json', import.meta.url), 'utf-8')
    );
    const healthyServers = botServers.filter(server => status[server.id]?.healthy);
    if (!healthyServers.length) return res.status(503).json({ message: 'No healthy bot servers' });

    // Fetch analytics from all healthy servers
    const results = await Promise.all(
      healthyServers.map(async server => {
        try {
          const { data } = await axios.get(`${server.url}/api/user/analytics`, { params: { authId } });
          // Assume data is { labels: [], commandProcessingTime: [] }
          return data;
        } catch (err) {
          return null;
        }
      })
    );

    // Merge analytics: concatenate labels and commandProcessingTime arrays
    const merged = results.filter(Boolean).reduce((acc, curr) => {
      if (curr.labels && curr.commandProcessingTime) {
        acc.labels.push(...curr.labels);
        acc.commandProcessingTime.push(...curr.commandProcessingTime);
      }
      return acc;
    }, { labels: [], commandProcessingTime: [] });

    res.json(merged);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/auth/register', handleRegister);
console.log('Register endpoint set up');
router.all('/auth/:action/:phoneNumber?', handleAuthAction);
console.log('Auth endpoints set up');

// Session endpoints (start, stop, restart, etc.)
router.post('/:action', handleSessionAction);
console.log('Session endpoints set up');

router.all('/user/:action/:phoneNumber?', handleUserAction);
// Add after your other admin endpoints in api.js
router.all('/admin/:action/:phoneNumber?', (req, res, next) => {
  if (req.params.action === 'bots-status') return next();
  return handleAdminAction(req, res);
});
console.log('User endpoints set up.');

export default router;