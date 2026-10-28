/**
 * PM2 Ecosystem Configuration for Slack Clone Backend
 *
 * Usage:
 *   Development:  pm2 start ecosystem.config.js
 *   Production:   pm2 start ecosystem.config.js --env production
 *   Scale:       pm2 scale slack-backend +2
 *   Specific cores: pm2 start ecosystem.config.js --env production -i 4
 */

module.exports = {
  apps: [
    {
      name: 'slack-backend',
      script: 'dist/main.js',

      // Cluster mode - automatically utilizes all CPU cores
      // Use 'fork' for single worker mode
      exec_mode: 'cluster',

      // Number of instances (-1 = all cores, 'max' = all cores, or specific number)
      instances: 'max',

      // Instance naming convention (index will be appended)
      instance_var: 'INSTANCE_ID',

      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,

      // Auto-restart on exceptions
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',

      // Environment variables
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // Logging configuration
      log_file: 'logs/combined.log',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Merge logs from all instances into single file
      merge_logs: true,

      // Enable source map support for better error stack traces
      source_map_support: true,

      // Watch for file changes (development only)
      watch: false,

      // Development-specific settings
      ...(process.env.NODE_ENV !== 'production' && {
        watch: true,
        ignore_watch: ['node_modules', 'dist', '.git', 'logs', '*.log'],
        max_memory_restart: '1G',
      }),

      // Production-specific settings
      ...(process.env.NODE_ENV === 'production' && {
        max_memory_restart: '2G',
        instance_scope: 'both',
      }),
    },
  ],
}
