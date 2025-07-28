
––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––  
//// FriendSuggestions.js  ////  
```javascript
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Image, TouchableOpacity, FlatList, StyleSheet, Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Automerge from 'automerge';

/**
 * @typedef {Object} User
 * @property {string} id
 * @property {string} name
 * @property {string} avatarUrl
 * @property {number} lastActive // timestamp
 * @property {string[]} interests
 * @property {string[]} groups
 */

/**
 * @typedef {Object} FollowMap
 * @property {Record<string, string[]>} data // key: userId, value: list of followerIds
 */

/**
 * Props for FriendSuggestions component
 * @typedef {Object} FriendSuggestionsProps
 * @property {string} currentUserId
 * @property {Function} [rankingFunction]  // (suggestion) => score
 * @property {boolean} [enableP2PSync] 
 * @property {(signal: any) => void} [onSignal]  // function to send WebRTC or custom signal data to peer
 * @property {(handler: (signal: any) => void) => void} [onReceiveSignal] // register incoming signal handler
 * @property {(peerId: string, data: Uint8Array) => void} [sendToPeer] // binary channel
 */

/**
 * Default ranking logic
 * @param {{mutualFollowers: number, sharedInterests: number, commonGroups: number, lastActive: number}} s 
 * @returns {number}
 */
const defaultRanker = s => 
  s.mutualFollowers * 0.4 +
  s.sharedInterests * 0.3 +
  s.commonGroups * 0.2 +
  (Date.now() - s.lastActive < 7 * 24 * 3600 * 1000 ? 1 : 0) * 0.1;

/**
 * Main component
 * @param {FriendSuggestionsProps} props
 */
export default function FriendSuggestions({
  currentUserId,
  rankingFunction = defaultRanker,
  enableP2PSync = false,
  onSignal,
  onReceiveSignal,
  sendToPeer,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [doc, setDoc] = useState(() =>
    Automerge.init({ freeze: true })
      .change(d => {
        d.users = {};
        d.follows = {};
      })
  );
  const docRef = useRef(doc);

  // Load saved Automerge binary from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('friend_suggestions_doc');
        if (raw) {
          const loaded = Automerge.load(raw);
          setDoc(loaded);
          docRef.current = loaded;
        }
      } catch (e) { console.warn(e); }
    })();
  }, []);

  // Persist on doc change
  useEffect(() => {
    const bin = Automerge.save(doc);
    AsyncStorage.setItem('friend_suggestions_doc', bin).catch(console.warn);
    docRef.current = doc;
    computeSuggestions();
  }, [doc]);

  // Optional P2P sync
  useEffect(() => {
    if (!enableP2PSync || !onSignal || !onReceiveSignal || !sendToPeer) return;
    // when doc changes, broadcast diff
    const syncState = Automerge.initSyncState();
    let syncSub;
    syncSub = Automerge.getChanges(docRef.current, Automerge.init())
      .forEach(change => sendToPeer('all', change));

    // receive remote
    onReceiveSignal(change => {
      const [newDoc] = Automerge.applyChanges(docRef.current, [change]);
      setDoc(newDoc);
    });
    return () => syncSub && syncSub();
  }, [enableP2PSync]);

  // Listen to connectivity to trigger sync if needed
  useEffect(() => {
    if (!enableP2PSync) return;
    const unsub = NetInfo.addEventListener(state => {
      if (state.isConnected) {
        // trigger full sync
        const changes = Automerge.getAllChanges(docRef.current);
        changes.forEach(c => sendToPeer('all', c));
      }
    });
    return () => unsub();
  }, [enableP2PSync]);

  /**
   * Add or update a user profile
   * @param {User} user 
   */
  const upsertUser = useCallback(user => {
    setDoc(Automerge.change(docRef.current, d => {
      d.users[user.id] = user;
      d.follows[user.id] = d.follows[user.id] || [];
    }));
  }, []);

  /**
   * Add a follow relationship
   * @param {string} followerId 
   * @param {string} followeeId 
   */
  const addFollow = useCallback((followerId, followeeId) => {
    setDoc(Automerge.change(docRef.current, d => {
      const arr = d.follows[followeeId] || [];
      if (!arr.includes(followerId)) arr.push(followerId);
    }));
  }, []);

  // Compute friend suggestions
  const computeSuggestions = useCallback(() => {
    const d = docRef.current;
    const me = d.users[currentUserId];
    if (!me) return setSuggestions([]);
    const iFollow = new Set(d.follows[currentUserId] || []);
    const mutuals = {};
    Object.entries(d.follows).forEach(([uid, followers]) => {
      if (uid === currentUserId || iFollow.has(uid)) return;
      // mutual followers
      const mf = followers.filter(f => (d.follows[currentUserId] || []).includes(f)).length;
      // interests
      const sharedInterests = me.interests.filter(i => d.users[uid].interests.includes(i)).length;
      // groups
      const commonGroups = me.groups.filter(g => d.users[uid].groups.includes(g)).length;
      mutuals[uid] = { uid, mutualFollowers: mf, sharedInterests, commonGroups, lastActive: d.users[uid].lastActive };
    });
    const arr = Object.values(mutuals)
      .map(s => ({ ...s, score: rankingFunction(s) }))
      .sort((a,b) => b.score - a.score);
    setSuggestions(arr);
  }, [currentUserId, rankingFunction]);

  // Recompute when doc or rankingFunction changes
  useEffect(() => computeSuggestions(), [doc, rankingFunction]);

  const { width } = Dimensions.get('window');
  const numCols = width > 600 ? 2 : 1;

  // Item renderer
  const renderItem = ({ item }) => {
    const u = doc.users[item.uid];
    return (
      <View style={styles.card}>
        <Image source={{uri: u.avatarUrl}} style={styles.avatar}/>
        <View style={styles.info}>
          <Text style={styles.name}>{u.name}</Text>
          <Text style={styles.meta}>{item.mutualFollowers} mutual • {item.sharedInterests} interests</Text>
          <TouchableOpacity style={styles.button} onPress={() => addFollow(currentUserId, item.uid)}>
            <Text style={styles.buttonText}>Follow</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <FlatList
      data={suggestions}
      keyExtractor={i => i.uid}
      renderItem={renderItem}
      numColumns={numCols}
      contentContainerStyle={styles.list}
    />
  );
}

const styles = StyleSheet.create({
  list: { padding: 8 },
  card: {
    flex: 1,
    flexDirection: 'row',
    margin: 8,
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    elevation: 1,
  },
  avatar: { width: 60, height: 60, borderRadius: 30 },
  info: { flex: 1, marginLeft: 12, justifyContent: 'space-between' },
  name: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 12, color: '#666' },
  button: { marginTop: 6, backgroundColor: '#3478f6', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 4 },
  buttonText: { color: '#fff', fontSize: 14 }
});
```  
––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––  

 
   `import FriendSuggestions from './FriendSuggestions';`  
   ```jsx
   <FriendSuggestions
     currentUserId={myId}
     rankingFunction={myCustomRanker}      // optional
     enableP2PSync={true}                   // toggle P2P
     onSignal={signal => signalingServer.send(signal)}  
     onReceiveSignal={handler => signalingServer.on('signal', handler)}
     sendToPeer={(peerId, data) => peerConnection.send(data)}
   />
   ```

