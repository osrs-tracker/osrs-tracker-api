module.exports = (options, webpack) => {
  // Optional packages Nest and Swagger import lazily and tolerate missing (Swagger only loads @fastify/static on Fastify)
  const lazyImports = [
    '@nestjs/microservices/microservices-module.js',
    '@nestjs/websockets/socket-module.js',
    '@fastify/static',
  ];

  return {
    ...options,
    externals: {
      sharp: 'commonjs sharp',
    },
    plugins: [
      ...options.plugins,
      new webpack.IgnorePlugin({
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
