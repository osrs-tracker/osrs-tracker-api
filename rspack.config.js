module.exports = (options, rspack) => {
  // Optional packages Nest imports lazily and tolerates missing. Nest CLI's rspack defaults list them without the `.js`
  // that Nest 12's ESM imports use, so they'd fail
  const lazyImports = [
    '@nestjs/microservices/microservices-module.js',
    '@nestjs/websockets/socket-module.js',
    // @nestjs/resilience imports these only to map its errors for non-HTTP transports
    '@nestjs/microservices',
    '@nestjs/websockets',
    'graphql',
  ];

  // The CLI adds the type check only when fork-ts-checker-webpack-plugin is installed, and skips it silently otherwise.
  // CI's build is the only type check, so fail instead
  if (!options.plugins.some((plugin) => plugin.constructor.name === 'ForkTsCheckerWebpackPlugin')) {
    throw new Error('fork-ts-checker-webpack-plugin is missing: the build would skip the type check');
  }

  return {
    ...options,
    // The CLI follows tsconfig.json's sourceMap; webpack emitted none, and node doesn't read them without
    // --enable-source-maps
    devtool: false,
    // Bundle all of node_modules: the image ships only dist/ plus sharp (Dockerfile)
    externals: {
      sharp: 'commonjs sharp',
    },
    plugins: [
      ...options.plugins,
      new rspack.IgnorePlugin({
        checkResource(resource) {
          if (lazyImports.includes(resource)) {
            try {
              require.resolve(resource);
            } catch (err) {
              return true;
            }
          }
          return false;
        },
      }),
    ],
  };
};
