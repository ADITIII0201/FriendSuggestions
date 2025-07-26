import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';

// Extracted constants to avoid magic numbers and repeated values
const CONSTANTS = {
  MUTUAL_FOLLOWERS_NORMALIZER: 10,
  ACTIVITY_DECAY_DAYS: 30,
  RECENT_ACTIVITY_DAYS: 7,
  WEBSOCKET_READY_STATE: 1,
  AVATAR_SIZE: 144,
  CONNECT_DELAY_MS: 800,
  STORAGE_RETRY_DELAY: 1000,
  MAX_INTERESTS_DISPLAY: 3,
  CARD_ANIMATION_DURATION: 300,
  WEBSOCKET_TIMEOUT: 5000
};

const DEFAULT_RANKING_WEIGHTS = Object.freeze({
  mutualFollowers: 0.4,
  recentActivity: 0.2,
  sharedInterests: 0.25,
  commonGroups: 0.15
});

const SAMPLE_USERS = Object.freeze([
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
]);

// Optional Automerge import with proper error handling
const loadAutomerge = () => {
  try {
    return require('@automerge/automerge');
  } catch (error) {
    console.warn('Automerge not available - P2P sync disabled:', error.message);
    return null;
  }
};

const Automerge = loadAutomerge();

/**
 * Validation schemas for type safety
 */
const ValidationSchema = {
  user: {
    requiredFields: ['id', 'name'],
    optionalFields: ['avatar', 'interests', 'groups', 'lastActive', 'isOnline']
  },
  connection: {
    requiredFields: ['userId'],
    optionalFields: ['strength', 'mutualFollowers']
  }
};

/**
 * Safe data validator with comprehensive error handling
 * @param {unknown} data - Data to validate
 * @param {object} schema - Validation schema
 * @returns {object|null} Validated data or null
 */
const validateData = (data, schema) => {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const hasRequiredFields = schema.requiredFields.every(field => {
    const value = data[field];
    return value !== null && value !== undefined && value !== '';
  });

  if (!hasRequiredFields) {
    return null;
  }

  return data;
};

/**
 * Validate and normalize user data with comprehensive type checking
 * @param {unknown} user - User data to validate
 * @returns {object|null} Validated user or null
 */
const validateUser = (user) => {
  const validatedUser = validateData(user, ValidationSchema.user);
  if (!validatedUser) {
    return null;
  }

  try {
    return {
      id: String(validatedUser.id),
      name: String(validatedUser.name).trim(),
      avatar: validatedUser.avatar ? String(validatedUser.avatar) : '',
      interests: Array.isArray(validatedUser.interests) ? validatedUser.interests : [],
      groups: Array.isArray(validatedUser.groups) ? validatedUser.groups : [],
      lastActive: typeof validatedUser.lastActive === 'number' ? validatedUser.lastActive : Date.now(),
      isOnline: Boolean(validatedUser.isOnline)
    };
  } catch (error) {
    console.error('User validation error:', error);
    return null;
  }
};

/**
 * Validate and normalize connection data
 * @param {unknown} connection - Connection data to validate
 * @returns {object|null} Validated connection or null
 */
const validateConnection = (connection) => {
  const validatedConnection = validateData(connection, ValidationSchema.connection);
  if (!validatedConnection) {
    return null;
  }

  try {
    return {
      userId: String(validatedConnection.userId),
      strength: typeof validatedConnection.strength === 'number' ? 
        Math.max(0, Math.min(1, validatedConnection.strength)) : 0.5,
      mutualFollowers: Array.isArray(validatedConnection.mutualFollowers) ? 
        validatedConnection.mutualFollowers : []
    };
  } catch (error) {
    console.error('Connection validation error:', error);
    return null;
  }
};

/**
 * Safe calculation of suggestion score with error boundaries
 * @param {object} user - User to calculate score for
 * @param {object} currentUser - Current user
 * @param {Array} connections - Existing connections
 * @param {object} weights - Ranking weights
 * @returns {number} Calculated score (0-1)
 */
const calculateSuggestionScore = (user, currentUser, connections, weights) => {
  try {
    if (!user || !currentUser || !Array.isArray(connections)) {
      return 0;
    }

    // Safely calculate mutual score
    const userConnections = connections.filter(c => c?.userId === user.id);
    const mutualCount = userConnections.reduce((sum, conn) => {
      const mutualFollowers = conn?.mutualFollowers;
      return sum + (Array.isArray(mutualFollowers) ? mutualFollowers.length : 0);
    }, 0);
    const mutualScore = Math.min(mutualCount / CONSTANTS.MUTUAL_FOLLOWERS_NORMALIZER, 1);

    // Safely calculate activity score
    const lastActive = user.lastActive || 0;
    const daysSinceActive = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
    const activityScore = Math.max(0, 1 - (daysSinceActive / CONSTANTS.ACTIVITY_DECAY_DAYS));

    // Safely calculate interests score
    const userInterests = user.interests || [];
    const currentUserInterests = currentUser.interests || [];
    const sharedInterests = userInterests.filter(interest => 
      currentUserInterests.includes(interest)
    ).length;
    const interestsScore = userInterests.length > 0 ? 
      Math.min(sharedInterests / userInterests.length, 1) : 0;

    // Safely calculate groups score
    const userGroups = user.groups || [];
    const currentUserGroups = currentUser.groups || [];
    const commonGroups = userGroups.filter(group => 
      currentUserGroups.includes(group)
    ).length;
    const groupsScore = userGroups.length > 0 ? 
      Math.min(commonGroups / userGroups.length, 1) : 0;

    // Calculate weighted final score
    const finalScore = (
      mutualScore * weights.mutualFollowers +
      activityScore * weights.recentActivity +
      interestsScore * weights.sharedInterests +
      groupsScore * weights.commonGroups
    );

    return Math.max(0, Math.min(1, finalScore)); // Ensure score is between 0 and 1
  } catch (error) {
    console.error('Error calculating suggestion score:', error);
    return 0;
  }
};

/**
 * Safe localStorage operations with error handling and retry logic
 * @param {string} key - Storage key
 * @param {unknown} defaultValue - Default value if not found
 * @returns {Array} [value, setter] tuple
 */
const useOfflineStorage = (key, defaultValue) => {
  const [value, setValue] = useState(() => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        return defaultValue;
      }
      
      const item = localStorage.getItem(key);
      return item ? JSON.parse(item) : defaultValue;
    } catch (error) {
      console.warn(`Failed to read from localStorage for key "${key}":`, error.message);
      return defaultValue;
    }
  });

  const setStoredValue = useCallback((newValue) => {
    const safeSetValue = (val) => {
      try {
        if (typeof window === 'undefined' || !window.localStorage) {
          setValue(val);
          return;
        }

        setValue(val);
        localStorage.setItem(key, JSON.stringify(val));
      } catch (error) {
        console.error(`Failed to save to localStorage for key "${key}":`, error.message);
        
        // Retry after a delay if quota exceeded
        if (error.name === 'QuotaExceededError') {
          setTimeout(() => {
            try {
              localStorage.removeItem(key); // Clear corrupted data
              localStorage.setItem(key, JSON.stringify(val));
            } catch (retryError) {
              console.error('Retry failed:', retryError.message);
            }
          }, CONSTANTS.STORAGE_RETRY_DELAY);
        }
      }
    };

    safeSetValue(newValue);
  }, [key]);

  return [value, setStoredValue];
};

/**
 * Safe P2P sync with comprehensive WebSocket error handling
 * @param {string|null} docId - Document ID for sync
 * @param {object} initialData - Initial document data
 * @returns {Array} [doc, updateDoc] tuple
 */
const useP2PSync = (docId, initialData) => {
  const [doc, setDoc] = useState(() => {
    if (!Automerge || !docId) {
      return initialData;
    }
    
    try {
      return Automerge.from(initialData);
    } catch (error) {
      console.error('Failed to initialize Automerge document:', error);
      return initialData;
    }
  });
  
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const cleanupWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const updateDoc = useCallback((updater) => {
    if (!Automerge || !docId) {
      return;
    }
    
    try {
      setDoc(currentDoc => {
        if (!currentDoc) {
          return currentDoc;
        }
        
        const newDoc = Automerge.change(currentDoc, updater);
        
        // Safely broadcast changes to peers
        const ws = wsRef.current;
        if (ws && ws.readyState === CONSTANTS.WEBSOCKET_READY_STATE) {
          try {
            const changes = Automerge.getChanges(currentDoc, newDoc);
            const message = JSON.stringify({
              type: 'sync',
              docId,
              changes: changes.map(c => Array.from(c))
            });
            
            ws.send(message);
          } catch (sendError) {
            console.error('Failed to send WebSocket message:', sendError);
          }
        }
        
        return newDoc;
      });
    } catch (error) {
      console.error('Failed to update Automerge document:', error);
    }
  }, [docId]);

  // Initialize P2P connection with retry logic
  useEffect(() => {
    if (!Automerge || !docId) {
      return undefined;
    }

    const connectWebSocket = () => {
      try {
        // Use a more reliable WebSocket endpoint or implement your own
        const ws = new WebSocket('wss://echo.websocket.org/');
        wsRef.current = ws;

        const timeoutId = setTimeout(() => {
          if (ws.readyState !== CONSTANTS.WEBSOCKET_READY_STATE) {
            ws.close();
            console.warn('WebSocket connection timeout');
          }
        }, CONSTANTS.WEBSOCKET_TIMEOUT);

        ws.onopen = () => {
          clearTimeout(timeoutId);
          console.log('WebSocket connected successfully');
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'sync' && message.docId === docId && Array.isArray(message.changes)) {
              setDoc(currentDoc => {
                if (!currentDoc) {
                  return currentDoc;
                }
                
                try {
                  const changes = message.changes.map(c => new Uint8Array(c));
                  return Automerge.applyChanges(currentDoc, changes);
                } catch (applyError) {
                  console.error('Failed to apply changes:', applyError);
                  return currentDoc;
                }
              });
            }
          } catch (parseError) {
            console.error('P2P sync message parse error:', parseError);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          clearTimeout(timeoutId);
        };

        ws.onclose = () => {
          clearTimeout(timeoutId);
          console.log('WebSocket connection closed');
          
          // Implement reconnection logic
          reconnectTimeoutRef.current = setTimeout(() => {
            if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
              console.log('Attempting to reconnect...');
              connectWebSocket();
            }
          }, CONSTANTS.WEBSOCKET_TIMEOUT);
        };
      } catch (error) {
        console.error('Failed to initialize WebSocket connection:', error);
      }
    };

    connectWebSocket();

    return cleanupWebSocket;
  }, [docId, cleanupWebSocket]);

  return [doc, updateDoc];
};

/**
 * Generate secure fallback avatar URL
 * @param {string} name - User's name
 * @returns {string} Avatar URL
 */
const generateAvatarUrl = (name) => {
  if (!name || typeof name !== 'string') {
    return `https://ui-avatars.com/api/?name=User&size=${CONSTANTS.AVATAR_SIZE}&background=6D83F2&color=ffffff&font-size=0.6`;
  }
  
  const safeName = encodeURIComponent(name.trim().substring(0, 50)); // Limit length for URL safety
  return `https://ui-avatars.com/api/?name=${safeName}&size=${CONSTANTS.AVATAR_SIZE}&background=6D83F2&color=ffffff&font-size=0.6`;
};

/**
 * Memoized suggestion card component with comprehensive error handling
 */
const SuggestionCard = React.memo(({ 
  user, 
  currentUser, 
  connections, 
  onDismiss, 
  onConnect, 
  onClick,
  debug = false
}) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [imageError, setImageError] = useState(false);

  // Safely calculate display metrics with memoization
  const mutualConnections = useMemo(() => {
    try {
      if (!Array.isArray(connections) || !user?.id) {
        return 0;
      }
      
      return connections.filter(c => {
        const mutualFollowers = c?.mutualFollowers;
        return Array.isArray(mutualFollowers) && mutualFollowers.includes(user.id);
      }).length;
    } catch (error) {
      if (debug) {
        console.error('Error calculating mutual connections:', error);
      }
      return 0;
    }
  }, [connections, user?.id, debug]);

  const sharedInterests = useMemo(() => {
    try {
      const userInterests = user?.interests || [];
      const currentUserInterests = currentUser?.interests || [];
      
      if (!Array.isArray(userInterests) || !Array.isArray(currentUserInterests)) {
        return [];
      }
      
      return userInterests
        .filter(interest => currentUserInterests.includes(interest))
        .slice(0, CONSTANTS.MAX_INTERESTS_DISPLAY);
    } catch (error) {
      if (debug) {
        console.error('Error calculating shared interests:', error);
      }
      return [];
    }
  }, [user?.interests, currentUser?.interests, debug]);

  const isRecentlyActive = useMemo(() => {
    try {
      const lastActive = user?.lastActive || 0;
      const daysSinceActive = (Date.now() - lastActive) / (1000 * 60 * 60 * 24);
      return daysSinceActive < CONSTANTS.RECENT_ACTIVITY_DAYS;
    } catch (error) {
      if (debug) {
        console.error('Error checking recent activity:', error);
      }
      return false;
    }
  }, [user?.lastActive, debug]);

  const avatarUrl = useMemo(() => {
    if (imageError || !user?.avatar) {
      return generateAvatarUrl(user?.name);
    }
    return user.avatar;
  }, [user?.avatar, user?.name, imageError]);

  const handleConnect = useCallback(async () => {
    if (isConnecting || !onConnect || !user) {
      return;
    }

    setIsConnecting(true);
    try {
      await onConnect(user);
      
      // Simulate network delay for better UX
      setTimeout(() => {
        setIsConnecting(false);
      }, CONSTANTS.CONNECT_DELAY_MS);
    } catch (error) {
      console.error('Connection error:', error);
      setIsConnecting(false);
    }
  }, [isConnecting, onConnect, user]);

  const handleDismiss = useCallback((event) => {
    event?.stopPropagation();
    if (onDismiss && user?.id) {
      onDismiss(user.id);
    }
  }, [onDismiss, user?.id]);

  const handleClick = useCallback(() => {
    if (onClick && user) {
      onClick(user);
    }
  }, [onClick, user]);

  const handleImageError = useCallback(() => {
    setImageError(true);
  }, []);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }, [handleClick]);

  if (!user || !user.id || !user.name) {
    return null;
  }

  return (
    <article className="card">
      <button 
        className="dismiss" 
        onClick={handleDismiss}
        aria-label={`Dismiss suggestion for ${user.name}`}
        type="button"
      >
        ✕
      </button>

      <div 
        className={`avatar ${user.isOnline ? 'online' : 'offline'}`}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        aria-label={`View ${user.name}'s profile`}
      >
        <img 
          src={avatarUrl}
          alt={`${user.name}'s avatar`}
          onError={handleImageError}
          loading="lazy"
        />
      </div>

      <div className="card-content" onClick={handleClick}>
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
            <span className="activity-dot" aria-hidden="true"></span>
            Recently active
          </div>
        )}

        {debug && user.score !== undefined && (
          <div className="debug-score">
            Score: {user.score.toFixed(3)}
          </div>
        )}
      </div>

      <button
        className="connect"
        onClick={handleConnect}
        disabled={isConnecting}
        type="button"
        aria-label={`Connect with ${user.name}`}
      >
        {isConnecting ? 'Connecting...' : 'Connect'}
      </button>
    </article>
  );
});

// Add display name for debugging
SuggestionCard.displayName = 'SuggestionCard';

// Define PropTypes for type checking
SuggestionCard.propTypes = {
  user: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    avatar: PropTypes.string,
    interests: PropTypes.arrayOf(PropTypes.string),
    groups: PropTypes.arrayOf(PropTypes.string),
    lastActive: PropTypes.number,
    isOnline: PropTypes.bool,
    score: PropTypes.number
  }).isRequired,
  currentUser: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    interests: PropTypes.arrayOf(PropTypes.string),
    groups: PropTypes.arrayOf(PropTypes.string)
  }).isRequired,
  connections: PropTypes.arrayOf(PropTypes.object).isRequired,
  onDismiss: PropTypes.func.isRequired,
  onConnect: PropTypes.func.isRequired,
  onClick: PropTypes.func,
  debug: PropTypes.bool
};

/**
 * Main App component with comprehensive error boundaries and validation
 */
const App = ({
  rankingWeights = DEFAULT_RANKING_WEIGHTS,
  maxSuggestions = 8,
  enableP2PSync = false,
  className = '',
  debug = false
}) => {
  // Sample data with proper memoization
  const currentUser = useMemo(() => ({
    id: 'user123',
    name: 'John Doe',
    avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop&crop=face',
    interests: ['music', 'travel', 'tech', 'cooking'],
    groups: ['developers', 'music-lovers'],
    lastActive: Date.now(),
    isOnline: true
  }), []);

  const connections = useMemo(() => [
    {
      userId: 'user999',
      strength: 0.8,
      mutualFollowers: ['user456', 'user789']
    }
  ], []);

  // Validate and normalize input data with error handling
  const validatedCurrentUser = useMemo(() => {
    const validated = validateUser(currentUser);
    if (!validated && debug) {
      console.error('Invalid currentUser data:', currentUser);
    }
    return validated;
  }, [currentUser, debug]);

  const validatedUsers = useMemo(() => {
    const validated = SAMPLE_USERS.map(validateUser).filter(Boolean);
    if (debug) {
      console.log(`Validated ${validated.length} out of ${SAMPLE_USERS.length} users`);
    }
    return validated;
  }, [debug]);

  const validatedConnections = useMemo(() => {
    const validated = connections.map(validateConnection).filter(Boolean);
    if (debug) {
      console.log(`Validated ${validated.length} out of ${connections.length} connections`);
    }
    return validated;
  }, [connections, debug]);

  // Error boundary for invalid current user
  if (!validatedCurrentUser) {
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

  // Offline storage with error handling
  const [dismissedSuggestions, setDismissedSuggestions] = useOfflineStorage(
    `dismissed_suggestions_${validatedCurrentUser.id}`, 
    []
  );

  // P2P sync with conditional initialization
  const [syncedData, updateSyncedData] = useP2PSync(
    enableP2PSync ? `suggestions_${validatedCurrentUser.id}` : null,
    { suggestions: [], lastUpdated: Date.now() }
  );

  // Calculate and rank friend suggestions with comprehensive error handling
  const suggestions = useMemo(() => {
    try {
      if (!validatedUsers || !Array.isArray(validatedUsers)) {
        return [];
      }

      // Filter out current user, existing connections, and dismissed suggestions
      const connectedUserIds = validatedConnections.map(c => c.userId);
      const dismissedIds = Array.isArray(dismissedSuggestions) ? dismissedSuggestions : [];
      
      const candidateUsers = validatedUsers.filter(user => {
        if (!user || !user.id) {
          return false;
        }
        
        return user.id !== validatedCurrentUser.id &&
          !connectedUserIds.includes(user.id) &&
          !dismissedIds.includes(user.id);
      });

      if (debug) {
        console.log(`Found ${candidateUsers.length} candidate users for suggestions`);
      }

      // Calculate scores and sort with error handling
      const scoredSuggestions = candidateUsers
        .map(user => {
          const score = calculateSuggestionScore(
            user, 
            validatedCurrentUser, 
            validatedConnections, 
            rankingWeights
          );
          
          return {
            ...user,
            score: Number.isFinite(score) ? score : 0
          };
        })
        .filter(user => user.score > 0) // Filter out users with zero score
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(50, maxSuggestions))); // Ensure reasonable limits

      if (debug) {
        console.log('Top suggestions:', scoredSuggestions.map(s => ({ 
          name: s.name, 
          score: s.score.toFixed(3) 
        })));
      }

      return scoredSuggestions;
    } catch (error) {
      console.error('Error calculating suggestions:', error);
      return [];
    }
  }, [
    validatedUsers, 
    validatedCurrentUser, 
    validatedConnections, 
    rankingWeights, 
    maxSuggestions, 
    dismissedSuggestions, 
    debug
  ]);

  // Event handlers with proper error handling
  const handleDismiss = useCallback((userId) => {
    if (!userId || typeof userId !== 'string') {
      console.error('Invalid userId provided to handleDismiss');
      return;
    }

    try {
      const currentDismissed = Array.isArray(dismissedSuggestions) ? dismissedSuggestions : [];
      const newDismissed = [...currentDismissed, userId];
      setDismissedSuggestions(newDismissed);
      
      if (enableP2PSync && updateSyncedData && typeof updateSyncedData === 'function') {
        updateSyncedData(doc => {
          if (doc) {
            doc.dismissed = newDismissed;
            doc.lastUpdated = Date.now();
          }
        });
      }
    } catch (error) {
      console.error('Error dismissing suggestion:', error);
    }
  }, [dismissedSuggestions, setDismissedSuggestions, enableP2PSync, updateSyncedData]);

  const handleConnect = useCallback(async (user) => {
    if (!user || !user.id || !user.name) {
      console.error('Invalid user provided to handleConnect');
      return;
    }

    try {
      console.log('🤝 Connect request sent to:', user.name);
      
      // Simulate API call with proper error handling
      await new Promise((resolve, reject) => {
        setTimeout(() => {
          // Simulate occasional network failures for testing
          if (Math.random() > 0.9) {
            reject(new Error('Network timeout'));
          } else {
            resolve(undefined);
          }
        }, CONSTANTS.CONNECT_DELAY_MS);
      });
      
      alert(`Connection request sent to ${user.name}!`);
      
      if (enableP2PSync && updateSyncedData && typeof updateSyncedData === 'function') {
        updateSyncedData(doc => {
          if (doc) {
            if (!Array.isArray(doc.pendingConnections)) {
              doc.pendingConnections = [];
            }
            doc.pendingConnections.push({
              userId: user.id,
              timestamp: Date.now()
            });
          }
        });
      }
    } catch (error) {
      console.error('Error handling connect request:', error);
      alert(`Failed to send connection request to ${user.name}. Please try again.`);
    }
  }, [enableP2PSync, updateSyncedData]);

  const handleSuggestionClick = useCallback((user) => {
    if (!user || !user.name) {
      return;
    }
    console.log('👁️ Viewing profile of:', user.name);
  }, []);

  // Early returns for edge cases
  if (validatedUsers.length === 0) {
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
                <p>Dismissed: {Array.isArray(dismissedSuggestions) ? dismissedSuggestions.length : 0}</p>
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
              onDismiss={handleDismiss}
              onConnect={handleConnect}
              onClick={handleSuggestionClick}
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

// PropTypes for the main App component
App.propTypes = {
  rankingWeights: PropTypes.shape({
    mutualFollowers: PropTypes.number,
    recentActivity: PropTypes.number,
    sharedInterests: PropTypes.number,
    commonGroups: PropTypes.number
  }),
  maxSuggestions: PropTypes.number,
  enableP2PSync: PropTypes.bool,
  className: PropTypes.string,
  debug: PropTypes.bool
};

/* ---------- ENHANCED CSS WITH ACCESSIBILITY IMPROVEMENTS ---------- */
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

/* Focus styles for accessibility */
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

.debug-score {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 8px;
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

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  :root {
    --border: #000;
    --border-hover: #333;
    --shadow-sm: none;
    --shadow-md: none;
    --shadow-lg: none;
    --shadow-xl: none;
  }
  
  .card {
    border: 2px solid var(--border);
  }
}
`;

export default App;
