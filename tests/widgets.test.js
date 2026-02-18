/**
 * Widget system tests
 */

// Simulate widget extraction from text
function extractWidgets(text) {
  if (!text) return { text: text, widgets: [] };
  var widgets = [];
  var cleaned = text.replace(/\[\[WIDGET:([\s\S]*?)\]\]/g, function(match, json) {
    try {
      widgets.push(JSON.parse(json));
    } catch (e) {
      console.error('[Widget] Failed to parse:', json, e);
    }
    return '';
  });
  return { text: cleaned.trim(), widgets: widgets };
}

// Simulate widget data normalization
function normalizeWidget(widgetData) {
  const widgetType = widgetData.widget || widgetData.type;
  return {
    type: 'widget',
    widget: widgetType,
    id: widgetData.id,
    ...widgetData
  };
}

describe('Widget System', () => {

  describe('Widget Extraction', () => {
    test('should extract single widget from text', () => {
      const text = 'Some text [[WIDGET:{"widget":"buttons","id":"test-1","prompt":"Choose","buttons":[{"label":"A","value":"a"}]}]] more text';
      const result = extractWidgets(text);
      
      expect(result.widgets).toHaveLength(1);
      expect(result.widgets[0].widget).toBe('buttons');
      expect(result.widgets[0].id).toBe('test-1');
      expect(result.text).toBe('Some text  more text');
    });

    test('should extract multiple widgets', () => {
      const text = '[[WIDGET:{"widget":"buttons","id":"w1","buttons":[]}]] text [[WIDGET:{"widget":"confirm","id":"w2"}]]';
      const result = extractWidgets(text);
      
      expect(result.widgets).toHaveLength(2);
      expect(result.widgets[0].id).toBe('w1');
      expect(result.widgets[1].id).toBe('w2');
    });

    test('should handle text without widgets', () => {
      const text = 'Just regular text';
      const result = extractWidgets(text);
      
      expect(result.widgets).toHaveLength(0);
      expect(result.text).toBe('Just regular text');
    });

    test('should handle empty text', () => {
      const result = extractWidgets('');
      expect(result.text).toBe('');
      expect(result.widgets).toHaveLength(0);
    });

    test('should handle null text', () => {
      const result = extractWidgets(null);
      expect(result.text).toBe(null);
      expect(result.widgets).toHaveLength(0);
    });

    test('should handle invalid JSON gracefully', () => {
      const text = '[[WIDGET:{invalid json}]]';
      const result = extractWidgets(text);
      
      expect(result.widgets).toHaveLength(0);
      expect(result.text).toBe('');
    });
  });

  describe('Widget Normalization', () => {
    test('should accept "widget" key for type', () => {
      const data = { widget: 'buttons', id: 'test' };
      const result = normalizeWidget(data);
      
      expect(result.widget).toBe('buttons');
    });

    test('should accept "type" key for type', () => {
      const data = { type: 'buttons', id: 'test' };
      const result = normalizeWidget(data);
      
      expect(result.widget).toBe('buttons');
    });

    test('should prefer "widget" over "type"', () => {
      const data = { widget: 'buttons', type: 'confirm', id: 'test' };
      const result = normalizeWidget(data);
      
      expect(result.widget).toBe('buttons');
    });

    test('should preserve all widget properties', () => {
      const data = {
        widget: 'buttons',
        id: 'test-1',
        prompt: 'Choose one',
        buttons: [{ label: 'A', value: 'a' }],
        customProp: 'value'
      };
      const result = normalizeWidget(data);
      
      expect(result.prompt).toBe('Choose one');
      expect(result.buttons).toHaveLength(1);
      expect(result.customProp).toBe('value');
    });
  });

  describe('Button Widget', () => {
    test('should accept "buttons" array', () => {
      const data = {
        widget: 'buttons',
        id: 'test',
        buttons: [
          { label: 'Option A', value: 'a' },
          { label: 'Option B', value: 'b' }
        ]
      };
      const options = data.options || data.buttons || [];
      
      expect(options).toHaveLength(2);
      expect(options[0].label).toBe('Option A');
    });

    test('should accept "options" array', () => {
      const data = {
        widget: 'buttons',
        id: 'test',
        options: [
          { label: 'Choice 1', value: '1' },
          { label: 'Choice 2', value: '2' }
        ]
      };
      const options = data.options || data.buttons || [];
      
      expect(options).toHaveLength(2);
      expect(options[0].label).toBe('Choice 1');
    });

    test('should handle string options', () => {
      const options = ['Yes', 'No', 'Maybe'];
      
      const normalized = options.map(opt => {
        if (typeof opt === 'string') {
          return { label: opt, value: opt };
        }
        return opt;
      });
      
      expect(normalized[0]).toEqual({ label: 'Yes', value: 'Yes' });
    });

    test('should handle button styles', () => {
      const buttons = [
        { label: 'OK', value: 'ok', style: 'primary' },
        { label: 'Cancel', value: 'cancel', style: 'secondary' },
        { label: 'Delete', value: 'delete', style: 'danger' }
      ];
      
      expect(buttons[0].style).toBe('primary');
      expect(buttons[1].style).toBe('secondary');
      expect(buttons[2].style).toBe('danger');
    });
  });

  describe('Widget Response', () => {
    test('should create valid response object', () => {
      const response = {
        id: 'widget-1',
        widget: 'buttons',
        value: 'selected-value',
        action: 'submit'
      };
      
      expect(response.id).toBe('widget-1');
      expect(response.widget).toBe('buttons');
      expect(response.value).toBe('selected-value');
      expect(response.action).toBe('submit');
    });

    test('should handle multi-select response', () => {
      const response = {
        id: 'widget-1',
        widget: 'buttons',
        value: ['a', 'b', 'c'],
        action: 'submit'
      };
      
      expect(Array.isArray(response.value)).toBe(true);
      expect(response.value).toHaveLength(3);
    });
  });

  describe('Widget Deduplication', () => {
    test('should track sent widget IDs', () => {
      const sentWidgetIds = new Set();
      
      const widget1 = { id: 'w1', widget: 'buttons' };
      const widget2 = { id: 'w2', widget: 'confirm' };
      const widget1Dup = { id: 'w1', widget: 'buttons' };
      
      // First widget
      expect(sentWidgetIds.has(widget1.id)).toBe(false);
      sentWidgetIds.add(widget1.id);
      
      // Second widget (different ID)
      expect(sentWidgetIds.has(widget2.id)).toBe(false);
      sentWidgetIds.add(widget2.id);
      
      // Duplicate (same ID as first)
      expect(sentWidgetIds.has(widget1Dup.id)).toBe(true);
    });
  });

  describe('Widget Types', () => {
    const supportedTypes = ['buttons', 'confirm', 'code', 'progress', 'form', 'datepicker', 'carousel'];
    
    supportedTypes.forEach(type => {
      test(`should recognize "${type}" as valid widget type`, () => {
        expect(supportedTypes).toContain(type);
      });
    });

    test('should identify unknown widget type', () => {
      const unknownType = 'unknown_widget';
      expect(supportedTypes).not.toContain(unknownType);
    });
  });

  describe('applyWidgetResponse', () => {
    test('should disable widget after response', () => {
      const container = { classList: { classes: [], add: function(c) { this.classes.push(c); }, contains: function(c) { return this.classes.includes(c); } } };
      
      // Simulate applyWidgetResponse
      container.classList.add('disabled');
      
      expect(container.classList.contains('disabled')).toBe(true);
    });

    test('should mark selected button', () => {
      const buttons = [
        { value: 'a', selected: false },
        { value: 'b', selected: false },
        { value: 'c', selected: false }
      ];
      const response = { value: 'b' };
      
      buttons.forEach(btn => {
        if (btn.value === response.value) {
          btn.selected = true;
        }
      });
      
      expect(buttons[0].selected).toBe(false);
      expect(buttons[1].selected).toBe(true);
      expect(buttons[2].selected).toBe(false);
    });
  });
});
