<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Assistant tone presets and combined instructions sent to the chat API.
 */
final class Tone
{
    public const OPT_PRESET = 'ai_ebot_tone_preset';

    /**
     * @return array<string, string> slug => admin label
     */
    public static function preset_labels(): array
    {
        return [
            'custom' => __('Custom (instructions only)', 'wp-ai-ebot'),
            'friendly' => __('Friendly retail', 'wp-ai-ebot'),
            'professional' => __('Professional B2B', 'wp-ai-ebot'),
            'concise' => __('Concise', 'wp-ai-ebot'),
            'support' => __('Customer support', 'wp-ai-ebot'),
        ];
    }

    /**
     * Base instruction block for each preset (English; combined with custom text when preset is not custom).
     */
    public static function preset_boilerplate(string $preset): string
    {
        $map = [
            'friendly' => __(
                'You are a warm, approachable retail assistant. Use clear, short paragraphs. Be genuinely helpful and positive. When unsure, say so and suggest what you can look up.',
                'wp-ai-ebot'
            ),
            'professional' => __(
                'You are a formal, precise assistant for business buyers. Avoid slang. Be accurate and structured. Reference policies and product facts carefully.',
                'wp-ai-ebot'
            ),
            'concise' => __(
                'Keep answers brief by default. Use bullet points when listing options. Ask at most one clarifying question if the request is ambiguous.',
                'wp-ai-ebot'
            ),
            'support' => __(
                'You are a patient support agent. Acknowledge the shopper’s situation. Offer step-by-step help when useful. Stay calm and solution-focused.',
                'wp-ai-ebot'
            ),
        ];

        return $map[$preset] ?? '';
    }

    /**
     * Full tone string sent to the API: preset boilerplate plus optional custom instructions.
     */
    public static function effective_tone(): string
    {
        $preset = sanitize_key((string) get_option(self::OPT_PRESET, 'custom'));
        $allowed = array_keys(self::preset_labels());
        if (! in_array($preset, $allowed, true)) {
            $preset = 'custom';
        }

        $custom = trim((string) get_option('ai_ebot_tone', ''));

        if ($preset === 'custom') {
            return $custom;
        }

        $base = trim(self::preset_boilerplate($preset));
        if ($custom === '') {
            return $base;
        }

        return $base . "\n\n" . $custom;
    }
}
