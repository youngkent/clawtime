/**
 * E2E Tests - Full flow with mocked gateway
 * Tests the complete message flow including avatar state sync
 */

// Simulate the websocket handler logic
describe('E2E Message Flow', () => {
  let sharedAvatarState;
  let sharedRunIds;
  let broadcasts;
  
  beforeEach(() => {
    sharedAvatarState = 'idle';
    sharedRunIds = new Set();
    broadcasts = [];
  });
  
  function broadcast(msg) {
    broadcasts.push(msg);
  }
  
  function broadcastExcept(msg, excludeWs) {
    broadcasts.push({ ...msg, _excluded: excludeWs?.id });
  }
  
  function sharedTrackRunId(runId) {
    sharedRunIds.add(runId);
  }
  
  function sharedIsTracked(runId) {
    return sharedRunIds.has(runId);
  }
  
  function handleChatEvent(payload) {
    if (payload?.sessionKey !== 'agent:main:main') return false;
    if (!sharedIsTracked(payload.runId)) return false;
    
    const state = payload.state;
    const contentBlocks = payload.message?.content || [];
    const text = contentBlocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n\n');
    
    // Skip internal signals
    const trimmed = (text || '').trim();
    if (trimmed === 'NO_REPLY' || trimmed === 'HEARTBEAT_OK') return false;
    
    const cleanText = text.replace(/\[\[WIDGET:[\s\S]*?\]\]/g, '').trim();
    
    // Broadcast to clients
    broadcast({ type: 'chat', state, runId: payload.runId, text: cleanText });
    
    // Avatar state
    if (state === 'final') {
      sharedRunIds.delete(payload.runId);
      sharedAvatarState = 'idle';
      broadcast({ type: 'avatar_state', state: 'idle' });
    } else if (contentBlocks.some(b => b.type === 'tool_use')) {
      sharedAvatarState = 'working';
      broadcast({ type: 'avatar_state', state: 'working' });
    }
    
    return true;
  }
  
  function handleClientAvatarState(msg, clientWs) {
    if (msg.type === 'avatar_state' && msg.state) {
      sharedAvatarState = msg.state;
      broadcastExcept({ type: 'avatar_state', state: msg.state }, clientWs);
      return true;
    }
    return false;
  }
  
  describe('Avatar State Sync', () => {
    test('should update sharedAvatarState when client sends avatar_state', () => {
      const clientWs = { id: 'client1' };
      const msg = { type: 'avatar_state', state: 'happy' };
      
      handleClientAvatarState(msg, clientWs);
      
      expect(sharedAvatarState).toBe('happy');
    });
    
    test('should broadcast avatar_state to other clients', () => {
      const client1 = { id: 'client1' };
      const msg = { type: 'avatar_state', state: 'coding' };
      
      handleClientAvatarState(msg, client1);
      
      expect(broadcasts.length).toBe(1);
      expect(broadcasts[0].type).toBe('avatar_state');
      expect(broadcasts[0].state).toBe('coding');
      expect(broadcasts[0]._excluded).toBe('client1');
    });
    
    test('should preserve avatar state for new client connection', () => {
      // Client 1 sets avatar state
      const client1 = { id: 'client1' };
      handleClientAvatarState({ type: 'avatar_state', state: 'celebrating' }, client1);
      
      expect(sharedAvatarState).toBe('celebrating');
      
      // Client 2 connects - should get 'celebrating' not 'idle'
      const connectMessage = { type: 'connected', avatarState: sharedAvatarState };
      expect(connectMessage.avatarState).toBe('celebrating');
    });
    
    test('should reset avatar to idle on final message', () => {
      const runId = 'test-run-123';
      sharedTrackRunId(runId);
      sharedAvatarState = 'working';
      
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'Done!' }] }
      });
      
      expect(sharedAvatarState).toBe('idle');
    });
    
    test('should allow client to override idle after final', () => {
      const runId = 'test-run-456';
      sharedTrackRunId(runId);
      
      // Server sends final -> sets idle
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'Great success!' }] }
      });
      expect(sharedAvatarState).toBe('idle');
      
      // Client sets celebrating based on content
      const client1 = { id: 'client1' };
      handleClientAvatarState({ type: 'avatar_state', state: 'celebrating' }, client1);
      
      expect(sharedAvatarState).toBe('celebrating');
    });
    
    test('should handle page reload scenario', () => {
      // Simulate: message sent, response received, client sets avatar
      const runId = 'test-run-789';
      sharedTrackRunId(runId);
      
      // Delta
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Working on it...' }] }
      });
      
      // Final
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'All done! 🎉' }] }
      });
      
      // Client sets celebrating
      const client1 = { id: 'client1' };
      handleClientAvatarState({ type: 'avatar_state', state: 'celebrating' }, client1);
      expect(sharedAvatarState).toBe('celebrating');
      
      // Page reload - new client connects
      const newClientConnectMsg = { type: 'connected', avatarState: sharedAvatarState };
      expect(newClientConnectMsg.avatarState).toBe('celebrating');
    });
  });
  
  describe('Chat Response Flow', () => {
    test('should track runId when sending message', () => {
      const runId = 'response-run-001';
      sharedTrackRunId(runId);
      
      expect(sharedIsTracked(runId)).toBe(true);
    });
    
    test('should process chat event for tracked runId', () => {
      const runId = 'response-run-002';
      sharedTrackRunId(runId);
      
      const result = handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Hello!' }] }
      });
      
      expect(result).toBe(true);
      expect(broadcasts.some(b => b.type === 'chat' && b.text === 'Hello!')).toBe(true);
    });
    
    test('should ignore chat event for wrong sessionKey', () => {
      const runId = 'response-run-003';
      sharedTrackRunId(runId);
      
      const result = handleChatEvent({
        sessionKey: 'wrong:session:key',
        runId,
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Hello!' }] }
      });
      
      expect(result).toBe(false);
    });
    
    test('should ignore chat event for untracked runId', () => {
      const result = handleChatEvent({
        sessionKey: 'agent:main:main',
        runId: 'untracked-run',
        state: 'delta',
        message: { content: [{ type: 'text', text: 'Hello!' }] }
      });
      
      expect(result).toBe(false);
    });
    
    test('should skip NO_REPLY messages', () => {
      const runId = 'noreply-run';
      sharedTrackRunId(runId);
      
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'NO_REPLY' }] }
      });
      
      expect(broadcasts.filter(b => b.type === 'chat').length).toBe(0);
    });
    
    test('should skip HEARTBEAT_OK messages', () => {
      const runId = 'heartbeat-run';
      sharedTrackRunId(runId);
      
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'final',
        message: { content: [{ type: 'text', text: 'HEARTBEAT_OK' }] }
      });
      
      expect(broadcasts.filter(b => b.type === 'chat').length).toBe(0);
    });
    
    test('should set working avatar on tool_use', () => {
      const runId = 'tool-run';
      sharedTrackRunId(runId);
      
      handleChatEvent({
        sessionKey: 'agent:main:main',
        runId,
        state: 'delta',
        message: { content: [{ type: 'tool_use', name: 'exec' }, { type: 'text', text: 'Running command...' }] }
      });
      
      expect(sharedAvatarState).toBe('working');
      expect(broadcasts.some(b => b.type === 'avatar_state' && b.state === 'working')).toBe(true);
    });
  });
  
  describe('Multi-Client Scenarios', () => {
    test('should sync avatar state across multiple clients', () => {
      const client1 = { id: 'client1' };
      const client2 = { id: 'client2' };
      
      // Client 1 changes avatar
      handleClientAvatarState({ type: 'avatar_state', state: 'thinking' }, client1);
      
      // Should broadcast to client2 (not client1)
      const broadcastToOthers = broadcasts.find(b => b._excluded === 'client1');
      expect(broadcastToOthers).toBeDefined();
      expect(broadcastToOthers.state).toBe('thinking');
      
      // Shared state updated
      expect(sharedAvatarState).toBe('thinking');
    });
    
    test('should handle rapid state changes', () => {
      const client1 = { id: 'client1' };
      
      handleClientAvatarState({ type: 'avatar_state', state: 'working' }, client1);
      handleClientAvatarState({ type: 'avatar_state', state: 'thinking' }, client1);
      handleClientAvatarState({ type: 'avatar_state', state: 'celebrating' }, client1);
      
      expect(sharedAvatarState).toBe('celebrating');
      expect(broadcasts.length).toBe(3);
    });
  });
});
