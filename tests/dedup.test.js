/**
 * Message deduplication tests - runId-based (no prefix/length detection)
 */

describe('Message Deduplication', () => {
  let botMessagesByRunId;
  
  beforeEach(() => {
    botMessagesByRunId = new Map();
  });
  
  // Simple runId-based logic: same runId = same message
  function processMessage(state, runId, text) {
    const existing = botMessagesByRunId.get(runId);
    
    if (state === 'delta') {
      if (existing && !existing.finalized) {
        // Same runId, update content
        existing.text = text;
        return { action: 'updated' };
      } else {
        // New runId or finalized — create new
        botMessagesByRunId.set(runId, { text, runId, finalized: false });
        return { action: 'new_bubble' };
      }
    } else if (state === 'final') {
      if (existing && !existing.finalized) {
        existing.text = text;
        existing.finalized = true;
        return { action: 'finalized' };
      } else if (!existing) {
        botMessagesByRunId.set(runId, { text, runId, finalized: true });
        return { action: 'new_bubble' };
      }
      return { action: 'ignored' };
    }
  }
  
  describe('Delta messages', () => {
    test('should create new bubble for new runId', () => {
      const result = processMessage('delta', 'run-1', 'Hello');
      expect(result.action).toBe('new_bubble');
      expect(botMessagesByRunId.has('run-1')).toBe(true);
    });
    
    test('should update existing bubble for same runId', () => {
      processMessage('delta', 'run-1', 'Hello');
      const result = processMessage('delta', 'run-1', 'Hello world');
      expect(result.action).toBe('updated');
      expect(botMessagesByRunId.get('run-1').text).toBe('Hello world');
    });
    
    test('should always use latest text for same runId', () => {
      processMessage('delta', 'run-1', 'Hello world');
      processMessage('delta', 'run-1', 'Hi'); // shorter, but should still update
      expect(botMessagesByRunId.get('run-1').text).toBe('Hi');
    });
    
    test('should create new bubble after runId finalized', () => {
      processMessage('delta', 'run-1', 'First');
      processMessage('final', 'run-1', 'First done');
      const result = processMessage('delta', 'run-1', 'Second');
      expect(result.action).toBe('new_bubble');
    });
  });
  
  describe('Final messages', () => {
    test('should finalize existing delta', () => {
      processMessage('delta', 'run-1', 'Hello');
      const result = processMessage('final', 'run-1', 'Hello world');
      expect(result.action).toBe('finalized');
      expect(botMessagesByRunId.get('run-1').finalized).toBe(true);
    });
    
    test('should create bubble for new final message', () => {
      const result = processMessage('final', 'run-1', 'Quick response');
      expect(result.action).toBe('new_bubble');
      expect(botMessagesByRunId.get('run-1').finalized).toBe(true);
    });
    
    test('should ignore final for already finalized runId', () => {
      processMessage('final', 'run-1', 'Done');
      const result = processMessage('final', 'run-1', 'Done again');
      expect(result.action).toBe('ignored');
    });
  });
  
  describe('Multiple runIds', () => {
    test('should handle multiple concurrent runIds', () => {
      processMessage('delta', 'run-1', 'Message 1');
      processMessage('delta', 'run-2', 'Message 2');
      processMessage('delta', 'run-3', 'Message 3');
      
      expect(botMessagesByRunId.size).toBe(3);
    });
    
    test('should update correct runId independently', () => {
      processMessage('delta', 'run-1', 'A');
      processMessage('delta', 'run-2', 'B');
      processMessage('delta', 'run-1', 'A updated');
      
      expect(botMessagesByRunId.get('run-1').text).toBe('A updated');
      expect(botMessagesByRunId.get('run-2').text).toBe('B');
    });
  });
});

describe('Widget Deduplication', () => {
  test('should detect existing widget by ID', () => {
    const renderedWidgets = new Set(['widget-123', 'widget-456']);
    
    function shouldRenderWidget(widgetId) {
      return !renderedWidgets.has(widgetId);
    }
    
    expect(shouldRenderWidget('widget-123')).toBe(false);
    expect(shouldRenderWidget('widget-789')).toBe(true);
  });
});
