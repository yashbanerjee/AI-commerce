<?php

declare(strict_types=1);

namespace AI_Ebot;

/**
 * Legacy helper: session id validation. Chat transcripts live on the AI Ebot API, not WordPress.
 */
final class Chat_Store
{
    public static function is_valid_public_id(string $id): bool
    {
        return $id !== '' && (bool) preg_match('/^[a-f0-9-]{36}$/i', $id);
    }

    /**
     * Activation hook: chat tables are no longer created (history is on the AI Ebot server).
     */
    public static function activate(): void
    {
        // Intentionally empty. Uninstall may still DROP legacy wp_ai_ebot_chat_* tables if present.
    }
}
