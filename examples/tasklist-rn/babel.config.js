// `expo-router/babel` est déprécié depuis le SDK 50 : babel-preset-expo suffit.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
