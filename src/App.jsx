import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

// Optional Automerge import for P2P sync
let Automerge;
try {
  Automerge = require('@automerge/automerge');
} catch (e) {
  console.warn('Automerge not available - P2P sync disabled');
}

/**
 * Default ranking weights for friend suggestions
 */
const DEFAULT_RANKING_WEIGHTS = {
  mutualFollowers: 0.4,
  recentActivity: 0.2,
  sharedInterests: 0.25,
  commonGroups: 0.15
};

/**
 * Validate and normalize user data
 */
const validateUser = (user) => {
  if (!user || typeof user !== 'object' || !user.id || !user.name) {
    return null;
  }
  
  return {
    id: String(user.id),
    name: String(user.name),
    avatar: user.avatar || '',
    interests: Array.isArray(user.interests) ? user.interests : [],
    groups: Array.isArray(user.groups) ? user.groups : [],
    lastActive: typeof user.lastActive === 'number' ? user.lastActive : Date.now(),
    isOnline: Boolean(user.isOnline)
  };
};

/**
 * Validate and normalize connection data
 */
const validateConnection = (connection) => {
  if (!connection || typeof connection !== 'object' || !connection.userId) {
    return null;
  }
  
  return {
    userId: String(connection.userId),
    strength: typeof connection.strength === 'number' ? connection.strength : 0.5,
    mutualFollowers: Array.isArray(connection.mutualFollowers) ? connection.mutualFollowers : []
  };
};

/**
 * Calculate suggestion score for a potential friend
 */
const calculateSuggestionScore = (user, currentUser, connections, weights) => {
  try {
    // Get mutual followers
    const userConnections = connections.filter(c => c.userId === user.id);
    const mutualCount = userConnections.reduce((sum, conn) => sum + (conn.mutualFollowers?.length || 0), 0);
    const mutualScore = Math.min(mutualCount / 10, 1);

    // Calculate recent activity score
    const daysSinceActive = (Date.now() - (user.lastActive || 0)) / (1000 * 60 * 60 * 24);
    const activityScore = Math.max(0, 1 - (daysSinceActive / 30));

    // Calculate shared interests score
    const userInterests = user.interests || [];
    const currentUserInterests = currentUser.interests || [];
    const sharedInterests = userInterests.filter(interest => 
      currentUserInterests.includes(interest)
    ).length;
    const interestsScore = userInterests.length > 0 ? 
      Math.min(sharedInterests / userInterests.length, 1) : 0;

    // Calculate common groups score
    const userGroups = user.groups || [];
    const currentUserGroups = currentUser.groups || [];
    const commonGroups = userGroups.filter(group => 
      currentUserGroups.includes(group)
    ).length;
    const groupsScore = userGroups.length > 0 ? 
      Math.min(commonGroups / userGroups.length, 1) : 0;

    // Weighted final score
    return (
      mutualScore * weights.mutualFollowers +
      activityScore * weights.recentActivity +
      interestsScore * weights.sharedInterests +
      groupsScore * weights.commonGroups
    );
  } catch (error) {
    console.error('Error calculating suggestion score:', error);
    return 0;
  }
};

/**
 * Custom hook for offline storage management
 */
const useOfflineStorage = (key, defaultValue) => {
  const [value, setValue] = useState(() => {
    try {
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
      console.warn('Failed to read from localStorage:', error);
      return defaultValue;
    }
  });

  const setStoredValue = useCallback((newValue) => {
    try {
      setValue(newValue);
      localStorage.setItem(key, JSON.stringify(newValue));
    } catch (error) {
      console.error('Failed to save to localStorage:', error);
    }
  }, [key]);

  return [value, setStoredValue];
};

/**
 * Custom hook for P2P sync using Automerge
 */
const useP2PSync = (docId, initialData) => {
  const [doc, setDoc] = useState(() => {
    if (!Automerge) return initialData;
    try {
      return Automerge.from(initialData);
    } catch (error) {
      console.error('Failed to initialize Automerge document:', error);
      return initialData;
    }
  });
  
  const wsRef = useRef(null);

  const updateDoc = useCallback((updater) => {
    if (!Automerge) return;
    
    try {
      setDoc(currentDoc => {
        const newDoc = Automerge.change(currentDoc, updater);
        
        // Broadcast changes to peers
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const changes = Automerge.getChanges(currentDoc, newDoc);
          wsRef.current.send(JSON.stringify({
            type: 'sync',
            docId,
            changes: changes.map(c => Array.from(c))
          }));
        }
        
        return newDoc;
      });
    } catch (error) {
      console.error('Failed to update Automerge document:', error);
    }
  }, [docId]);

  // Initialize P2P connection
  useEffect(() => {
    if (!Automerge || !docId) return;

    try {
      // Replace with your P2P signaling server
      const ws = new WebSocket('wss://echo.websocket.org/');
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'sync' && message.docId === docId) {
            setDoc(currentDoc => {
              const changes = message.changes.map(c => new Uint8Array(c));
              return Automerge.applyChanges(currentDoc, changes);
            });
          }
        } catch (error) {
          console.error('P2P sync message error:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      return () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
      };
    } catch (error) {
      console.error('Failed to initialize P2P connection:', error);
    }
  }, [docId]);

  return [doc, updateDoc];
};

/**
 * Generate fallback avatar URL
 */
const generateAvatarUrl = (name) => {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=144&background=6D83F2&color=ffffff&font-size=0.6`;
};

/**
 * Individual suggestion card component
 */
const SuggestionCard = ({ 
  user, 
  currentUser, 
  connections, 
  onDismiss, 
  onConnect, 
  onClick,
  debug = false
}) => {
  const [isConnecting, setIsConnecting] = useState(false);

  // Calculate display metrics safely
  const mutualConnections = useMemo(() => {
    try {
      return connections.filter(c => 
        c.mutualFollowers && c.mutualFollowers.includes(user.id)
      ).length;
    } catch (error) {
      if (debug) console.error('Error calculating mutual connections:', error);
      return 0;
    }
  }, [connections, user.id, debug]);

  const sharedInterests = useMemo(() => {
    try {
      const userInterests = user.interests || [];
      const currentUserInterests = currentUser.interests || [];
      return userInterests.filter(interest =>
        currentUserInterests.includes(interest)
      ).slice(0, 3);
    } catch (error) {
      if (debug) console.error('Error calculating shared interests:', error);
      return [];
    }
  }, [user.interests, currentUser.interests, debug]);

  const isRecentlyActive = useMemo(() => {
    try {
      const lastActive = user.lastActive || 0;
      return (Date.now() - lastActive) < (7 * 24 * 60 * 60 * 1000);
    } catch (error) {
      if (debug) console.error('Error checking recent activity:', error);
      return false;
    }
  }, [user.lastActive, debug]);

  const avatarUrl = useMemo(() => {
    return user.avatar || generateAvatarUrl(user.name);
  }, [user.avatar, user.name]);

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      await onConnect(user);
      // Simulate network delay for better UX
      setTimeout(() => setIsConnecting(false), 1000);
    } catch (error) {
      console.error('Connection error:', error);
      setIsConnecting(false);
    }
  };

  return (
    <article className="card">
      <button 
        className="dismiss" 
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss suggestion"
      >
        ✕
      </button>

      <div 
        className={`avatar ${user.isOnline ? 'online' : 'offline'}`}
        onClick={onClick}
        role="button"
        tabIndex={0}
      >
        <img 
          src={avatarUrl}
          alt={`${user.name}'s avatar`}
          onError={(e) => {
            e.target.src = generateAvatarUrl(user.name);
          }}
        />
      </div>

      <div className="card-content" onClick={onClick}>
        <h3>{user.name}</h3>
        
        {mutualConnections > 0 && (
          <p className="mutuals">
            {mutualConnections} mutual connection{mutualConnections !== 1 ? 's' : ''}
          </p>
        )}

        {sharedInterests.length > 0 && (
          <div className="tags">
            {sharedInterests.map((interest, index) => (
              <span key={`${interest}-${index}`}>{interest}</span>
            ))}
          </div>
        )}

        {isRecentlyActive && (
          <div className="activity">
            <span className="activity-dot"></span>
            Recently active
          </div>
        )}

        {debug && (
          <div className="debug-score">
            Score: {user.score?.toFixed(3) || 'N/A'}
          </div>
        )}
      </div>

      <button
        className="connect"
        onClick={handleConnect}
        disabled={isConnecting}
      >
        {isConnecting ? 'Connecting...' : 'Connect'}
      </button>
    </article>
  );
};

/**
 * Main App component - Privacy-first social app with friend suggestions
 */
const App = ({
  rankingWeights = DEFAULT_RANKING_WEIGHTS,
  maxSuggestions = 8,
  enableP2PSync = false,
  className = '',
  debug = false
}) => {
  // Sample data that works out of the box
  const [currentUser] = useState({
    id: 'user123',
    name: 'John Doe',
    avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face',
    interests: ['music', 'travel', 'tech', 'cooking'],
    groups: ['developers', 'music-lovers'],
    lastActive: Date.now(),
    isOnline: true
  });

  const [allUsers] = useState([
    {
      id: 'user456',
      name: 'Jane Smith',
      avatar: 'https://images.unsplash.com/photo-1494790108755-2616b612b786?w=150&h=150&fit=crop&crop=face',
      interests: ['music', 'art', 'travel'],
      groups: ['developers', 'artists'],
      lastActive: Date.now() - 86400000, // 1 day ago
      isOnline: false
    },
    {
      id: 'user789',
      name: 'Bob Johnson',
      avatar: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&h=150&fit=crop&crop=face',
      interests: ['tech', 'travel', 'gaming'],
      groups: ['developers', 'gamers'],
      lastActive: Date.now() - 3600000, // 1 hour ago
      isOnline: true
    },
    {
      id: 'user101',
      name: 'Alice Brown',
      avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150&h=150&fit=crop&crop=face',
      interests: ['cooking', 'music', 'yoga'],
      groups: ['music-lovers', 'health'],
      lastActive: Date.now() - 7200000, // 2 hours ago
      isOnline: true
    },
    {
      id: 'user202',
      name: 'Charlie Wilson',
      interests: ['tech', 'gaming', 'music'],
      groups: ['developers', 'gamers'],
      lastActive: Date.now() - 1800000, // 30 minutes ago
      isOnline: true
    },
    {
      id: 'user303',
      name: 'Diana Ross',
      avatar: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&h=150&fit=crop&crop=face',
      interests: ['music', 'art', 'cooking'],
      groups: ['music-lovers', 'artists'],
      lastActive: Date.now() - 10800000, // 3 hours ago
      isOnline: false
    },
    {
      id: 'user404',
      name: 'Emma Wilson',
      avatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&h=150&fit=crop&crop=face',
      interests: ['yoga', 'travel', 'photography'],
      groups: ['health', 'photographers'],
      lastActive: Date.now() - 5400000, // 1.5 hours ago
      isOnline: true
    }
  ]);

  const [connections] = useState([
    {
      userId: 'user999',
      strength: 0.8,
      mutualFollowers: ['user456', 'user789']
    }
  ]);

  // Validate and normalize input data
  const validatedCurrentUser = useMemo(() => {
    const validated = validateUser(currentUser);
    if (!validated && debug) {
      console.error('Invalid currentUser data:', currentUser);
    }
    return validated;
  }, [currentUser, debug]);

  const validatedUsers = useMemo(() => {
    const validated = allUsers.map(validateUser).filter(Boolean);
    if (debug) {
      console.log(`Validated ${validated.length} out of ${allUsers.length} users`);
    }
    return validated;
  }, [allUsers, debug]);

  const validatedConnections = useMemo(() => {
    const validated = connections.map(validateConnection).filter(Boolean);
    if (debug) {
      console.log(`Validated ${validated.length} out of ${connections.length} connections`);
    }
    return validated;
  }, [connections, debug]);

  // Early return if no valid current user
  if (!validatedCurrentUser) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        <div className="error-state">
          <div className="error-icon">⚠️</div>
          <h3>Invalid User Data</h3>
          <p>Current user data is missing or invalid. Please check the user data.</p>
        </div>
      </div>
    );
  }

  // Offline storage for dismissed suggestions
  const [dismissedSuggestions, setDismissedSuggestions] = useOfflineStorage(
    `dismissed_suggestions_${validatedCurrentUser.id}`, 
    []
  );

  // P2P sync for suggestion data (optional)
  const [syncedData, updateSyncedData] = useP2PSync(
    enableP2PSync ? `suggestions_${validatedCurrentUser.id}` : null,
    { suggestions: [], lastUpdated: Date.now() }
  );

  // Calculate and rank friend suggestions
  const suggestions = useMemo(() => {
    try {
      // Filter out current user, existing connections, and dismissed suggestions
      const connectedUserIds = validatedConnections.map(c => c.userId);
      const candidateUsers = validatedUsers.filter(user => 
        user.id !== validatedCurrentUser.id &&
        !connectedUserIds.includes(user.id) &&
        !dismissedSuggestions.includes(user.id)
      );

      if (debug) {
        console.log(`Found ${candidateUsers.length} candidate users for suggestions`);
      }

      // Calculate scores and sort
      const scoredSuggestions = candidateUsers
        .map(user => ({
          ...user,
          score: calculateSuggestionScore(user, validatedCurrentUser, validatedConnections, rankingWeights)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSuggestions);

      if (debug) {
        console.log('Top suggestions:', scoredSuggestions.map(s => ({ name: s.name, score: s.score })));
      }

      return scoredSuggestions;
    } catch (error) {
      console.error('Error calculating suggestions:', error);
      return [];
    }
  }, [validatedUsers, validatedCurrentUser, validatedConnections, rankingWeights, maxSuggestions, dismissedSuggestions, debug]);

  const handleDismiss = useCallback((userId) => {
    try {
      const newDismissed = [...dismissedSuggestions, userId];
      setDismissedSuggestions(newDismissed);
      
      if (enableP2PSync && updateSyncedData) {
        updateSyncedData(doc => {
          doc.dismissed = newDismissed;
          doc.lastUpdated = Date.now();
        });
      }
    } catch (error) {
      console.error('Error dismissing suggestion:', error);
    }
  }, [dismissedSuggestions, setDismissedSuggestions, enableP2PSync, updateSyncedData]);

  const handleConnect = useCallback(async (user) => {
    try {
      console.log('🤝 Connect request sent to:', user.name);
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 800));
      
      alert(`Connection request sent to ${user.name}!`);
      
      if (enableP2PSync && updateSyncedData) {
        updateSyncedData(doc => {
          if (!doc.pendingConnections) doc.pendingConnections = [];
          doc.pendingConnections.push({
            userId: user.id,
            timestamp: Date.now()
          });
        });
      }
    } catch (error) {
      console.error('Error handling connect request:', error);
    }
  }, [enableP2PSync, updateSyncedData]);

  const handleSuggestionClick = useCallback((user) => {
    console.log('👁️ Viewing profile of:', user.name);
    // In a real app, this would navigate to the user's profile
  }, []);

  // Show loading state if no users provided
  if (validatedUsers.length === 0) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        <div className="empty-state">
          <div className="empty-icon">👥</div>
          <h3>No users available</h3>
          <p>Loading user data...</p>
        </div>
      </div>
    );
  }

  // Show empty state for no suggestions
  if (suggestions.length === 0) {
    return (
      <div className={`app-shell ${className}`}>
        <style>{globalCSS}</style>
        
        <header className="brand">
          <h1>🌐 Social Connect</h1>
          <p>Discover new connections based on mutual friends, interests & groups</p>
        </header>
        
        <div className="empty-state">
          <div className="empty-icon">🔍</div>
          <h3>No suggestions available</h3>
          <p>All available users are already connected or dismissed</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-shell ${className}`}>
      <style>{globalCSS}</style>

      {/* Brand Header */}
      <header className="brand">
        <h1>🌐 Social Connect</h1>
        <p>Discover new connections based on mutual friends, interests & groups</p>
      </header>

      {/* Suggestions Section */}
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
                <p>Current User: {validatedCurrentUser.name} ({validatedCurrentUser.id})</p>
                <p>Total Users: {validatedUsers.length}</p>
                <p>Connections: {validatedConnections.length}</p>
                <p>Dismissed: {dismissedSuggestions.length}</p>
                <p>P2P Sync: {enableP2PSync ? 'Enabled' : 'Disabled'}</p>
              </div>
            </details>
          </div>
        )}

        <div className="grid">
          {suggestions.map((user) => (
            <SuggestionCard
              key={user.id}
              user={user}
              currentUser={validatedCurrentUser}
              connections={validatedConnections}
              onDismiss={() => handleDismiss(user.id)}
              onConnect={handleConnect}
              onClick={() => handleSuggestionClick(user)}
              debug={debug}
            />
          ))}
        </div>
      </section>

      <footer className="footer">
        Built with React • Privacy-first • Offline-ready
      </footer>
    </div>
  );
};

/* ---------- GLOBAL CSS STYLES ---------- */
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
    --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.3);
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

.app-shell {
  min-height: 100vh;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

/* Brand Header */
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

/* Section Header */
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

/* Grid Layout */
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

/* Card Styles */
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
  cursor: pointer;
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

/* Dismiss Button */
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

.dismiss:hover {
  background: var(--border);
  color: var(--text-sub);
  transform: scale(1.1);
}

/* Avatar */
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
}

.avatar:hover {
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

/* Card Content */
.card-content {
  text-align: center;
  flex: 1;
  width: 100%;
  margin-bottom: 24px;
}

.card-content h3 {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 8px;
  letter-spacing: -0.025em;
}

.mutuals {
  color: var(--accent);
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 12px;
}

/* Tags */
.tags {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin-bottom: 12px;
}

.tags span {
  background: var(--chip-bg);
  color: var(--chip-text);
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  border: 1px solid var(--border);
  transition: all 0.2s ease;
}

.tags span:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}

/* Activity Indicator */
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
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

/* Connect Button */
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

.connect:hover {
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

/* Empty/Error States */
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

/* Debug Info */
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

.debug-content {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  color: var(--text-muted);
  line-height: 1.4;
}

.debug-score {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 8px;
}

/* Footer */
.footer {
  text-align: center;
  margin-top: 80px;
  padding: 32px 0;
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 0.875rem;
}

/* Responsive Design */
@media (max-width: 480px) {
  .app-shell {
    padding: 16px;
  }
  
  .brand {
    padding: 48px 8px 64px;
  }
  
  .card {
    padding: 24px 20px;
  }
  
  .section-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}

/* Smooth animations */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;

export default App;
