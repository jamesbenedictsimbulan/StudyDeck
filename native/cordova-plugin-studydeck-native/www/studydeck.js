/* StudyDeck native bridge (Promise wrappers around cordova exec). */
var exec = require('cordova/exec');

function call(action, args) {
  return new Promise(function (resolve, reject) {
    exec(resolve, function (err) { reject(err); }, 'StudyNative', action, args || []);
  });
}

module.exports = {
  checkPermission: function (key) { return call('checkPermission', [key]); },
  requestPermission: function (key) { return call('requestPermission', [key]); },
  openAppSettings: function () { return call('openAppSettings'); },
  openLocationSettings: function () { return call('openLocationSettings'); },
  isLocationEnabled: function () { return call('isLocationEnabled'); },

  startService: function () { return call('startService'); },
  stopService: function () { return call('stopService'); },
  isServiceRunning: function () { return call('isServiceRunning'); },
  setSensitivity: function (level) { return call('setSensitivity', [level]); },
  getSensitivity: function () { return call('getSensitivity'); },
  getHistory: function () { return call('getHistory'); },
  clearHistory: function () { return call('clearHistory'); },

  /* Hands a JPEG (base64) to the Android share sheet (implicit ACTION_SEND intent). */
  shareImage: function (base64, text) { return call('shareImage', [base64, text || '']); },

  /* Live events from the service: {type:'shake', entry} and {type:'service', running}. */
  onEvent: function (callback) {
    exec(callback, function () {}, 'StudyNative', 'listen', []);
  }
};
