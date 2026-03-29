(function (blocks, element, blockEditor, components, i18n) {
  var el = element.createElement;
  var Fragment = element.Fragment;
  var InspectorControls = blockEditor.InspectorControls;
  var PanelBody = components.PanelBody;
  var TextControl = components.TextControl;

  blocks.registerBlockType('ai-ebot/chat', {
    edit: function (props) {
      return el(
        Fragment,
        {},
        el(
          InspectorControls,
          {},
          el(
            PanelBody,
            { title: i18n.__('Chat', 'wp-ai-ebot'), initialOpen: true },
            el(TextControl, {
              label: i18n.__('Header title', 'wp-ai-ebot'),
              help: i18n.__('Leave empty to use the heading from AI Ebot → Appearance.', 'wp-ai-ebot'),
              value: props.attributes.title,
              onChange: function (v) {
                props.setAttributes({ title: v });
              },
            })
          )
        ),
        el(
          'div',
          { className: 'components-placeholder', style: { padding: '1rem', border: '1px dashed #ccc' } },
          el('p', {}, i18n.__('AI Ebot chat renders on the front end.', 'wp-ai-ebot'))
        )
      );
    },
    save: function () {
      return null;
    },
  });
})(window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components, window.wp.i18n);
