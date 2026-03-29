<?php

declare(strict_types=1);

spl_autoload_register(static function (string $class): void {
    $prefix = 'AI_Ebot\\';
    $base_dir = dirname(__DIR__) . '/includes/';

    $len = strlen($prefix);
    if (strncmp($prefix, $class, $len) !== 0) {
        return;
    }

    $relative = substr($class, $len);
    $file = $base_dir . str_replace('\\', '/', $relative) . '.php';

    if (is_readable($file)) {
        require $file;
    }
});
