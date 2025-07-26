import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from 'react';
import PropTypes from 'prop-types';

// ---------- CONSTANTS ----------
const C = {
  MUTUAL_NORMALIZER: 10,
  DECAY_DAYS: 30,
  RECENT_DAYS: 7,
  P2P_READY: 1,
  CONNECT_DELAY: 800,
  MAX_INTERESTS: 3
};

const DEFAULT_WEIGHTS = {
  mutualFollowers: 0.4,
  recentActivity: 0.2,
  sharedInterests: 0.25,
  commonGroups: 0.15
};

const SAMPLE_USERS = [
  {
    id: 'user456',
    name: 'Jane Smith',
    avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=150&h=150&fit=crop&crop=face',
    interests: ['music', 'art', 'travel'],
    groups: ['developers', 'artists'],
    lastActive: Date.now() - 86400000,
    isOnline: false
  },
  {
    id: 'user789',
    name: 'Bob Johnson',
    avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
    interests: ['tech', 'travel', 'gaming'],
    groups: ['developers', 'gamers'],
    lastActive: Date.now() - 3600000,
    isOnline: true
  },
  {
    id: 'user101',
    name: 'Alice Brown',
    avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&h=150&fit=crop&crop=face',
    interests: ['cooking', 'music', 'yoga'],
    groups: ['music-lovers', 'health'],
    lastActive: Date.now() - 7200000,
    isOnline: true
  },
  {
    id: 'user202',
    name: 'Charlie Wilson',
    interests: ['tech', 'gaming', 'music'],
    groups: ['developers', 'gamers'],
    lastActive: Date.now() - 1800000,
    isOnline: true
  },
  {
    id: 'user303',
    name: 'Diana Ross',
    avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&h=150&fit=crop&crop=face',
    interests: ['music', 'art', 'cooking'],
    groups: ['music-lovers', 'artists'],
    lastActive: Date.now() - 10800000,
    isOnline: false
  },
  {
    id: 'user404',
    name: 'Emma Wilson',
    avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&crop=face',
    interests: ['yoga', 'travel', 'photography'],
    groups: ['health', 'photographers'],
    lastActive: Date.now() - 5400000,
    isOnline: true
  }
];

// ---------- SECURE RANDOM GENERATOR ----------
/**
 * FIXED: Secure random number generator using crypto.getRandomValues()
 * Falls back to Math.random() only if crypto is not available
 * @returns {number} Cryptographically secure random number between 0 and 1
 */
const getSecureRandom = () => {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    // Use cryptographically secure random number generator
    const array = new Uint32Array(1);
    window.crypto.getRandomValues(array);
    return array[0] / (0xFFFFFFFF + 1);
  }
  
  if (typeof global !== 'undefined' && global.crypto && global.crypto.getRandomValues) {
    // Node.js environment with crypto
    const array = new Uint32Array(1);
    global.crypto.getRandomValues(array);
    return array[0] / (0xFFFFFFFF + 1);
  }
  
  // Fallback to Math.random() with warning (should only happen in very old environments)
  console.warn('Crypto API not available, falling back to Math.random()');
  return Math.random();
};

/**
 * FIXED: Secure random boolean generator for network simulation
 * @param {number} successProbability - Probability of success (0-1)
 * @returns {boolean} Secure random boolean
 */
const getSecureRandomBoolean = (successProbability = 0.9) => {
  return getSecureRandom() <= successProbability;
};

// ---------- UTILS ----------
const clamp01 = x => Math.max(0, Math.min(1, x));

function calculateScores(user, currentUser, connections, weights) {
  // 1) mutual
  const mutuals = connections
    .filter(c => c.userId === user.id)
    .reduce((sum, c) => sum + (c.mutualFollowers?.length || 0), 0);
  const mutualScore = clamp01(mutuals / C.MUTUAL_NORMALIZER);

  // 2) recent activity
  const daysAgo = (Date.now() - (user.lastActive || 0)) / (1000 * 60 * 60 * 24);
  const activityScore = clamp01(1 - daysAgo / C.DECAY_DAYS);

  // 3) interests
  const shared = user.interests
    ?.filter(i => currentUser.interests?.includes(i))
    .length || 0;
  const interestsScore = user.interests?.length
    ? clamp01(shared / user.interests.length)
    : 0;

  // 4) groups
  const common = user.groups
    ?.filter(g => currentUser.groups?.includes(g))
    .length || 0;
  const groupsScore = user.groups?.length
    ? clamp01(common / user.groups.length)
    : 0;

  return (
    mutualScore * weights.mutualFollowers +
    activityScore * weights.recentActivity +
    interestsScore * weights.sharedInterests +
    groupsScore * weights.commonGroups
  );
}

function validateUser(u) {
  if (!u?.id || !u?.name) return null;
  return {
    id: String(u.id),
    name: String(u.name),
    avatar: u.avatar || '',
    interests: Array.isArray(u.interests) ? u.interests : [],
    groups: Array.isArray(u.groups) ? u.groups : [],
    lastActive: typeof u.lastActive === 'number' ? u.lastActive : Date.now(),
    isOnline: !!u.isOnline
  };
}

function useOfflineStorage(key, fallback) {
  const [val, setVal] = useState(() => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return fallback;
      }
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : fallback;
    } catch (error) {
      console.warn(`Failed to read from localStorage: ${error.message}`);
      return fallback;
    }
  });
  
  const update = useCallback(newVal => {
    setVal(newVal);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(key, JSON.stringify(newVal));
      }
    } catch (error) {
      console.error(`Failed to save to localStorage: ${error.message}`);
    }
  }, [key]);
  
  return [val, update];
}

// Simplified P2P sync hook: returns only the updater
function useP2PSync(docId) {
  const wsRef = useRef(null);
  
  useEffect(() => {
    if (!docId) return;
    
    try {
      const ws = new WebSocket('wss://echo.websocket.org');
      wsRef.current = ws;
      
      ws.onopen = () => {
        console.log('P2P WebSocket connected');
      };
      
      ws.onerror = (error) => {
        console.error('P2P WebSocket error:', error);
      };
      
      ws.onclose = () => {
        console.log('P2P WebSocket disconnected');
      };
      
      return () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };
    } catch (error) {
      console.error('Failed to initialize P2P WebSocket:', error);
    }
  }, [docId]);

  const sendUpdate = useCallback(
    changes => {
      const ws = wsRef.current;
      if (ws?.readyState === C.P2P_READY) {
        try {
          ws.send(JSON.stringify({ docId, changes }));
        } catch (error) {
          console.error('Failed to send P2P update:', error);
        }
      }
    },
    [docId]
  );

  return sendUpdate;
}

// ---------- COMPONENTS ----------
const SuggestionCard = React.memo(function SuggestionCard({
  user,
  currentUser,
  connections,
  onDismiss,
  onConnect,
  onView
}) {
  const [busy, setBusy] = useState(false);

  const score = useMemo(
    () => calculateScores(user, currentUser, connections, DEFAULT_WEIGHTS),
    [user, currentUser, connections]
  );

  const handleConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConnect(user);
    } catch (error) {
      console.error('Connection failed:', error);
    } finally {
      setTimeout(() => setBusy(false), C.CONNECT_DELAY);
    }
  }, [busy, onConnect, user]);

  const handleDismiss = useCallback((event) => {
    event?.stopPropagation();
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  const handleView = useCallback(() => {
    onView(user);
  }, [onView, user]);

  if (!user?.id || !user?.name) {
    return null;
  }

  return (
    <div className="card">
      <button
        type="button"
        className="dismiss"
        onClick={handleDismiss}
        aria-label={`Dismiss suggestion for ${user.name}`}
      >
        ×
      </button>

      <button
        type="button"
        className={`avatar ${user.isOnline ? 'online' : 'offline'}`}
        onClick={handleView}
        aria-label={`View ${user.name}'s profile`}
      >
        <img
          src={user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&size=144&background=6D83F2&color=ffffff`}
          alt={`${user.name}'s avatar`}
          loading="lazy"
          onError={(e) => {
            e.target.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&size=144&background=6D83F2&color=ffffff`;
          }}
        />
      </button>

      <button
        type="button"
        className="content"
        onClick={handleView}
        aria-label={`View ${user.name}'s profile details`}
      >
        <h3>{user.name}</h3>
        {score > 0 && <p className="score">Score: {score.toFixed(2)}</p>}
        <div className="tags">
          {user.interests?.slice(0, C.MAX_INTERESTS).map((tag, index) => (
            <span key={`${tag}-${index}`} className="tag">
              {tag}
            </span>
          ))}
        </div>
        {user.isOnline && (
          <div className="activity">
            <span className="activity-dot" aria-hidden="true"></span>
            <span>Recently active</span>
          </div>
        )}
      </button>

      <button
        type="button"
        className="connect"
        onClick={handleConnect}
        disabled={busy}
        aria-label={`Connect with ${user.name}`}
      >
        {busy ? 'Connecting...' : 'Connect'}
      </button>
    </div>
  );
});

SuggestionCard.propTypes = {
  user: PropTypes.object.isRequired,
  currentUser: PropTypes.object.isRequired,
  connections: PropTypes.array.isRequired,
  onDismiss: PropTypes.func.isRequired,
  onConnect: PropTypes.func.isRequired,
  onView: PropTypes.func.isRequired
};

export default function App({
  maxSuggestions = 10,
  enableP2PSync = false,
  className = '',
  debug = false
}) {
  // 1) hooks unconditionally at top
  const [currentUser] = useState(() => 
    validateUser({
      id: 'user123',
      name: 'John Doe',
      avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face',
      interests: ['music', 'travel', 'tech', 'cooking'],
      groups: ['developers', 'music-lovers'],
      lastActive: Date.now(),
      isOnline: true
    })
  );
  
  const [users] = useState(() => SAMPLE_USERS.map(validateUser).filter(Boolean));
  
  const [connections] = useState([
    { 
      userId: 'user999', 
      mutualFollowers: ['user456', 'user789'] 
    }
  ]);
  
  const [dismissed, setDismissed] = useOfflineStorage(
    currentUser ? `dismissed_${currentUser.id}` : 'dismissed_fallback',
    []
  );
  
  const updateP2P = useP2PSync(
    enableP2PSync && currentUser ? `doc_${currentUser.id}` : null
  );

  // 2) suggestions logic
  const suggestions = useMemo(() => {
    try {
      if (!currentUser || !Array.isArray(users)) {
        return [];
      }

      const candidates = users.filter(u => {
        if (!u?.id) return false;
        
        return u.id !== currentUser.id &&
          !connections.some(c => c.userId === u.id) &&
          !dismissed.includes(u.id);
      });
      
      return candidates
        .map(u => ({
          ...u,
          score: calculateScores(u, currentUser, connections, DEFAULT_WEIGHTS)
        }))
        .filter(u => u.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(50, maxSuggestions)));
    } catch (error) {
      console.error('Error calculating suggestions:', error);
      return [];
    }
  }, [users, currentUser, connections, dismissed, maxSuggestions]);

  // 3) handlers
  const dismissOne = useCallback(id => {
    if (!id || typeof id !== 'string') {
      console.error('Invalid ID provided to dismissOne');
      return;
    }
    
    try {
      const newDismissed = [...dismissed, id];
      setDismissed(newDismissed);
      
      if (enableP2PSync && updateP2P) {
        updateP2P([{ op: 'dismiss', id, timestamp: Date.now() }]);
      }
    } catch (error) {
      console.error('Error dismissing suggestion:', error);
    }
  }, [dismissed, setDismissed, enableP2PSync, updateP2P]);

  const connectOne = useCallback(async user => {
    if (!user?.id || !user?.name) {
      console.error('Invalid user provided to connectOne');
      return;
    }

    try {
      console.log('🤝 Connect request sent to:', user.name);
      
      // FIXED: Use secure random for network simulation instead of Math.random()
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          // Use cryptographically secure random number for network simulation
          const networkSuccess = getSecureRandomBoolean(0.9); // 90% success rate
          
          if (networkSuccess) {
            resolve(undefined);
          } else {
            reject(new Error('Network timeout'));
          }
        }, C.CONNECT_DELAY);
      });
      
      if (enableP2PSync && updateP2P) {
        updateP2P([{ 
          op: 'connect', 
          id: user.id, 
          timestamp: Date.now() 
        }]);
      }
      
      alert(`Connection request sent to ${user.name}!`);
    } catch (error) {
      console.error('Connection failed:', error);
      alert(`Failed to send connection request to ${user.name}. Please try again.`);
    }
  }, [enableP2PSync, updateP2P]);

  const viewProfile = useCallback(user => {
    if (!user?.name) {
      console.error('Invalid user provided to viewProfile');
      return;
    }
    
    console.log('👁️ Viewing profile of:', user.name);
    
    if (debug) {
      alert(`Viewing ${user.name}'s profile`);
    }
  }, [debug]);

  // 4) early returns after hooks
  if (!currentUser) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        <div className="error-state">
          <div className="error-icon" aria-hidden="true">⚠️</div>
          <h3>Invalid User Data</h3>
          <p>Current user data is missing or invalid. Please check the user data.</p>
        </div>
      </div>
    );
  }
  
  if (users.length === 0) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">👥</div>
          <h3>No users available</h3>
          <p>Loading user data...</p>
        </div>
      </div>
    );
  }
  
  if (suggestions.length === 0) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        
        <header className="brand">
          <h1>🌐 Social Connect</h1>
          <p>Discover new connections based on mutual friends, interests & groups</p>
        </header>
        
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">🔍</div>
          <h3>No suggestions available</h3>
          <p>All available users are already connected or dismissed</p>
        </div>
      </div>
    );
  }

  // 5) render
  return (
    <div className={`app-shell ${className}`}>
      <style>{globalCSS}</style>

      <header className="brand">
        <h1>🌐 Social Connect</h1>
        <p>Discover new connections based on mutual friends, interests & groups</p>
      </header>

      <section className="suggestions">
        <div className="section-head">
          <h2>People you may know</h2>
          <span className="count-badge">
            {suggestions.length} suggestion{suggestions.length !== 1 ? 's' : ''}
          </span>
        </div>

        {debug && (
          <div className="debug-info">
            <details>
              <summary>Debug Information</summary>
              <div className="debug-content">
                <p>Current User: {currentUser.name} ({currentUser.id})</p>
                <p>Total Users: {users.length}</p>
                <p>Connections: {connections.length}</p>
                <p>Dismissed: {dismissed.length}</p>
                <p>P2P Sync: {enableP2PSync ? 'Enabled' : 'Disabled'}</p>
                <p>Crypto API: {typeof window !== 'undefined' && window.crypto ? 'Available' : 'Fallback'}</p>
              </div>
            </details>
          </div>
        )}

        <div className="grid">
          {suggestions.map(u => (
            <SuggestionCard
              key={u.id}
              user={u}
              currentUser={currentUser}
              connections={connections}
              onDismiss={dismissOne}
              onConnect={connectOne}
              onView={viewProfile}
            />
          ))}
        </div>
      </section>

      <footer className="footer">
        Built with React • Privacy-first • Offline-ready
      </footer>
    </div>
  );
}

App.propTypes = {
  maxSuggestions: PropTypes.number,
  enableP2PSync: PropTypes.bool,
  className: PropTypes.string,
  debug: PropTypes.bool
};

// ---------- ENHANCED CSS ----------
const globalCSS = `
:root {
  --bg: #f9fafb;
  --card-bg: hsla(0, 0%, 100%, 0.75);
  --glass-blur: 20px;
  --border: #e2e8f0;
  --border-hover: #cbd5e0;
  --brand-from: #667eea;
  --brand-to: #764ba2;
  --accent: #6D83F2;
  --text: #111827;
  --text-sub: #6b7280;
  --text-muted: #9ca3af;
  --chip-bg: #eef2ff;
  --chip-text: #4f46e5;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
  --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
  --shadow-xl: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 24px;
  --focus-ring: 0 0 0 3px rgba(102, 126, 234, 0.3);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f172a;
    --card-bg: hsla(220, 39%, 11%, 0.75);
    --border: #1e293b;
    --border-hover: #334155;
    --text: #f8fafc;
    --text-sub: #cbd5e1;
    --text-muted: #64748b;
    --chip-bg: #1e3a8a;
    --chip-text: #bfdbfe;
    --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 20px 25px -5p rgba(0, 0, 0, 0.3);
    --shadow-xl: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
  }
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*:focus {
  outline: none;
}

*:focus-visible {
  box-shadow: var(--focus-ring);
  outline: 2px solid transparent;
}

.app-shell {
  min-height: 100vh;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.brand {
  text-align: center;
  padding: 64px 16px 80px;
  margin-bottom: 32px;
}

.brand h1 {
  font-size: clamp(2.5rem, 5vw, 3.5rem);
  font-weight: 800;
  background: linear-gradient(135deg, var(--brand-from), var(--brand-to));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  margin-bottom: 16px;
  letter-spacing: -0.025em;
}

.brand p {
  color: var(--text-sub);
  max-width: 580px;
  margin: 0 auto;
  font-size: clamp(1rem, 2.5vw, 1.125rem);
  font-weight: 400;
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  flex-wrap: wrap;
  gap: 16px;
}

.section-head h2 {
  font-size: clamp(1.5rem, 3vw, 1.875rem);
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.025em;
}

.count-badge {
  background: var(--chip-bg);
  color: var(--chip-text);
  padding: 8px 16px;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 600;
  border: 1px solid var(--border);
}

.grid {
  display: grid;
  gap: 24px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

@media (max-width: 768px) {
  .grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 24px 28px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--shadow-md);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border-hover), transparent);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.card:hover {
  transform: translateY(-8px) scale(1.02);
  box-shadow: var(--shadow-xl);
  border-color: var(--border-hover);
}

.card:hover::before {
  opacity: 1;
}

.dismiss {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  font-size: 18px;
  color: var(--text-muted);
  cursor: pointer;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  transition: all 0.2s ease;
  z-index: 10;
}

.dismiss:hover,
.dismiss:focus-visible {
  background: var(--border);
  color: var(--text-sub);
  transform: scale(1.1);
}

.avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  overflow: hidden;
  position: relative;
  margin-bottom: 20px;
  border: 3px solid var(--border);
  transition: all 0.3s ease;
  cursor: pointer;
  background: none;
  padding: 0;
}

.avatar:hover,
.avatar:focus-visible {
  transform: scale(1.05);
  border-color: var(--accent);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.avatar:hover img {
  transform: scale(1.1);
}

.avatar::after {
  content: '';
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: 3px solid var(--card-bg);
  border-radius: 50%;
  background: var(--text-muted);
}

.avatar.online::after {
  background: var(--success);
  box-shadow: 0 0 0 2px var(--card-bg), 0 0 8px rgba(34, 197, 94, 0.3);
}

.content {
  text-align: center;
  flex: 1;
  width: 100%;
  margin-bottom: 24px;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
}

.content:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.content h3 {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
  letter-spacing: -0.025em;
}

.score {
  color: var(--accent);
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 12px;
}

.tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 12px;
}

.tag {
  background: var(--chip-bg);
  color: var(--chip-text);
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--border);
  transition: all 0.2s ease;
  margin: 2px;
}

.tag:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

.activity {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 0.75rem;
  color: var(--success);
  font-weight: 600;
  margin-top: 8px;
}

.activity-dot {
  width: 8px;
  height: 8px;
  background: var(--success);
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.connect {
  width: 100%;
  padding: 14px 24px;
  border: none;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--brand-from), var(--brand-to));
  color: white;
  font-weight: 700;
  font-size: 0.875rem;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.connect::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
  transition: left 0.5s ease;
}

.connect:hover::before {
  left: 100%;
}

.connect:hover,
.connect:focus-visible {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.connect:active {
  transform: translateY(0) scale(0.98);
}

.connect:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

.connect:disabled:hover {
  transform: none;
  box-shadow: none;
}

.empty-state,
.error-state {
  text-align: center;
  padding: 80px 24px;
  color: var(--text-sub);
  max-width: 500px;
  margin: 0 auto;
}

.empty-icon,
.error-icon {
  font-size: 4rem;
  margin-bottom: 24px;
  opacity: 0.7;
}

.empty-state h3,
.error-state h3 {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 12px;
}

.empty-state p,
.error-state p {
  font-size: 1rem;
  line-height: 1.6;
}

.error-state {
  color: var(--danger);
}

.error-state h3 {
  color: var(--danger);
}

.debug-info {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
}

.debug-info details {
  cursor: pointer;
}

.debug-info summary {
  font-weight: 600;
  color: var(--text-sub);
  margin-bottom: 12px;
}

.debug-info summary:focus-visible {
  box-shadow: var(--focus-ring);
  border-radius: 4px;
}

.debug-content {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  color: var(--text-muted);
  line-height: 1.4;
}

.footer {
  text-align: center;
  margin-top: 80px;
  padding: 32px 0;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.875rem;
}

@media (max-width: 480px) {
  .app-shell { padding: 16px; }
  .brand { padding: 48px 8px 64px; }
  .card { padding: 24px 20px; }
  .section-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

@media (prefers-contrast: high) {
  :root {
    --border: #000;
    --border-hover: #333;
    --shadow-sm: none;
    --shadow-md: none;
    --shadow-lg: none;
    --shadow-xl: none;
  }
  
  .card { border: 2px solid var(--border); }
}
`;
