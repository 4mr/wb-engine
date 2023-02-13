exports.init = engineInit;

var config = readConfig("/etc/wb-rules/wb-engine.conf");
var motion_timer_interval = 1
var scripts = {};

Number.prototype.round = function(places) {
	return +(Math.round(this + "e+" + places)  + "e-" + places);
}

String.prototype.fix = function() {
	return this.toLowerCase().replace(/[\(\)]/g, '').split(' ').join('_');
}

function engineInit() {
	log("wb-engine init");
	runShellCommand("/usr/bin/wb-engine-helper --start", {
		captureOutput: true,
		exitCallback: function(exitCode, capturedOutput) {
			devicesInit();
			scriptsInit();
			log("wb-engine init finished");
		}
	});
}

function devicesInit() {
	log("devicesInit");

	if (!config['devices_config']) return;

	config.devices_config.forEach(function (device){
		if (typeof device['dooya_create_cover'] != undefined) {
			topic = '/devices/' + device['id'] + '/meta/coverSet';

			trackMqtt(topic, function(msg){
				switch (msg.value) {
					case 'OPEN':
						dev[device['id']]['Open'] = true;
						break;
					case 'CLOSE':
						dev[device['id']]['Close'] = true;
						break;
					case 'STOP':
						dev[device['id']]['Stop'] = true;
						break;
				}
			});
		}
	});
}

function scriptsInit() {
	log("scriptsInit");

	if (!config['scripts']) return;

	config.scripts.forEach(function (script){
		switch (script['script_type']) {
			case 'thermostat':
				scriptThermostatInit(script);
				break;
			case 'motion':
				scriptMotionInit(script);
				break;
		}
	});
}

function termosatLogic(id) {
	var topic = '/devices/' + id + '/controls/';
	var temps = [];
	var relays = 0;
	var inverted = scripts[id].inverted;

	scripts[id].config.zones.forEach(function (zone, idx){
		if (zone.sensor == 'disabled' || zone.relay == 'disabled') {
			return;
		}

		var zoneName = 'zone' + (idx + 1);
		var temp = dev[zone.sensor];
		var tempError = (dev[zone.sensor+"#error"] == undefined) ? false : true;
		var relay = dev[zone.relay];

		if (!temp) {
			temp = 0.0;
			tempError = true;
		}

		if (scripts[id].state == 'off' || tempError) {
			// turn off
			relay = inverted;
		} else {
			if (scripts[id].mode == 'cool') {
				// cool
				if (temp >= (scripts[id].target + scripts[id].config.hysteresis)) {
					// turn on
					relay = !inverted;
				} else if (temp <= (scripts[id].target - scripts[id].config.hysteresis)) {
					// turn off
					relay = inverted;
				}
			} else {
				// heat
				if (temp >= (scripts[id].target + scripts[id].config.hysteresis)) {
					// turn off
					relay = inverted;
				} else if (temp <= (scripts[id].target - scripts[id].config.hysteresis)) {
					// turn on
					relay = !inverted;
				}
			}
		}

		if (relay != inverted) {
			// relay is on
			relays++;
		}

		var status = zoneName + '_status';
		var relay_status = zoneName + '_relay_status';

		temps[idx] = temp;
		publish(topic + status, temps[idx], 0, true);

		dev[zone.relay] = relay;
		publish(topic + relay_status, (relay) ? 1 : 0, 0, true);

		if (dev[id + '/' + status + '#error'] || tempError) {
			publish(topic + status + '/meta/error', (tempError) ? 'r' : '', 0, true);
		}
	});

	if (scripts[id].state != 'off') {
		scripts[id].state = (relays > 0) ? scripts[id].mode + 'ing' : 'idle';
	}

	var current_temp = temps[0];
	if (temps.length > 1) {
		current_temp = temps.reduce(function(x, y) { return x + y; });
		current_temp = current_temp / temps.length;
	}

	publish(topic + 'current', current_temp.round(1), 0, true);
	publish(topic + 'state', scripts[id].state, 0, true);
}

function scriptThermostatInit(script) {
	var id = "script_" + script['name'].fix();
	var enable = id + "/enable";
	var target = id + "/target";
	var topic = '/devices/' + id + '/controls/';

	if (typeof scripts[id] == 'undefined') {
		scripts[id] = {
			state: 'off',
			mode: script['mode'] || 'heat',
			inverted: false,
			sensors: [],
			sensorsErrors: [],
			target: script['temperature_target'] || script['temperature_min'],
			config: script
		}
		if (script['inverted_control'] === true) {
			scripts[id].inverted = true;
		}
	}

	if (dev[target]) {
		scripts[id].target = dev[target];
	}

	publish(topic + 'target', scripts[id].target, 0, true);

	if (dev[enable] || script.enabled) {
		// script enabled
		scripts[id].state = 'idle';
		publish(topic + 'enable', 1, 0, true);
	} else {
		// script disabled
		scripts[id].state = 'off';
		publish(topic + 'enable', 0, 0, true);
	}

	publish(topic + 'state', scripts[id].state, 0, true);

	log('scriptThermostatInit[{}]: mode={}, state={}, target={}', id, scripts[id].mode, scripts[id].state, scripts[id].target);

	trackMqtt('/devices/' + id + '/controls/+/on', function(msg){
		publish(msg.topic.replace('/on', ''), msg.value, 0, true);
	});

	script.zones.forEach(function (zone, idx){
		if (zone.sensor == 'disabled' || zone.relay == 'disabled') {
			return;
		}

		zoneid = idx + 1;
		scripts[id].sensors[idx] = zone.sensor;
		scripts[id].sensorsErrors[idx] = zone.sensor + "#error";
		// publish(topic + 'zone' + zoneid + '_status/meta/error', '', 0, true);
	});

	defineRule(id + ".sensor-rule", {
		whenChanged: scripts[id].sensors,
		then: function (value, devName, cellName) {
			termosatLogic(id)
		}
	});

	defineRule(id + ".error-rule", {
		whenChanged: scripts[id].sensorsErrors,
		then: function (value, devName, cellName) {
			termosatLogic(id)
		}
	});

	defineRule(id + ".on-off-rule", {
		whenChanged: enable,
		then: function (value, devName, cellName) {
			scripts[id].state = (value === true) ? 'idle' : 'off';
			termosatLogic(id)
		}
	});

	defineRule(id + ".target-rule", {
		whenChanged: target,
		then: function (value, devName, cellName) {
			if (value < scripts[id].config['temperature_min']) {
				value = scripts[id].config['temperature_min']
			}
			if (value > scripts[id].config['temperature_max']) {
				value = scripts[id].config['temperature_max']
			}
			scripts[id].target = value;
			termosatLogic(id)
		}
	});

	termosatLogic(id);
}

function motionLogicTimer(id) {
	var topic = '/devices/' + id + '/controls/';

	if (scripts[id].state == 'clear') {
		scripts[id].timer_time = scripts[id].timer_time - motion_timer_interval;
		if (scripts[id].timer_time <= 0) {
			motionRelay(id, false);
			scripts[id].timer_time = 0;
			scripts[id].timer = false
		}
	}
	publish(topic + 'wait_time', scripts[id].timer_time, 0, true);

	if (scripts[id].timer_time > 0) {
		scripts[id].timer = setTimeout(function(){
			motionLogicTimer(id)
		}, motion_timer_interval * 1000)
	}
}

function motionRelay(id, onOff) {
	var topic = '/devices/' + id + '/controls/';
	scripts[id].config.relays.forEach(function (relay, idx){
		if (relay.relay == 'disabled') { return; }
		dev[relay.relay] = onOff;
		var relayid = idx + 1;
		publish(topic + 'relay' + relayid + '_status', (onOff) ? 1 : 0, 0, true);
	});
}

function motionLogic(id) {
	var topic = '/devices/' + id + '/controls/';
	var motion = false;

	var old_state = scripts[id].state;

	scripts[id].config.sensors.forEach(function (sensor, idx){
		if (sensor.sensor == 'disabled') { return; }

		var old_status = scripts[id].config.sensors[idx]['status'];
		var sensorid = idx + 1;
		var motion_level = dev[sensor.sensor];

		var sensor_motion = false
		if (motion_level >= sensor.motion_level) {
			sensor_motion = true;
		}

		if (sensor_motion) {
			motion = true;
		}

		new_status = (sensor_motion) ? 1 : 0;

		if (old_status != new_status) {
			publish(topic + 'sensor' + sensorid + '_status', new_status, 0, true);
			scripts[id].config.sensors[idx]['status'] = new_status;
		}
	});

	if (scripts[id].state == 'off') {
		if (scripts[id].timer !== false) {
			clearTimeout(scripts[id].timer);
			scripts[id].timer = false;
			motionRelay(id, false);
		}
	} else {
		if (motion) {
			scripts[id].state = 'detected';
			scripts[id].timer_time = scripts[id].wait_time
			if (scripts[id].timer === false) {
				motionRelay(id, true);
				motionLogicTimer(id);
			}
		} else {
			scripts[id].state = 'clear';
		}
	}

	if (old_state != scripts[id].state) {
		publish(topic + 'state', scripts[id].state, 0, true);
	}
}

function scriptMotionInit(script) {
	var id = "script_" + script['name'].fix();
	var enable = id + "/enable";
	var topic = '/devices/' + id + '/controls/';

	log('scriptMotionInit[{}] enabled={}', id, script.enabled);

	if (typeof scripts[id] == 'undefined') {
		scripts[id] = {
			state: 'off',
			sensors: [],
			wait_time: script.wait_time,
			config: script,
			timer: false
		}
	}

	if (dev[enable] || script.enabled) {
		// script enabled
		scripts[id].state = 'clear';
		publish(topic + 'enable', 1, 0, true);
	} else {
		// script disabled
		publish(topic + 'enable', 0, 0, true);
	}

	publish(topic + 'state', scripts[id].state, 0, true);

	trackMqtt('/devices/' + id + '/controls/+/on', function(msg){
		publish(msg.topic.replace('/on', ''), msg.value, 0, true);
	});

	scripts[id].config.sensors.forEach(function (sensor, idx){
		if (sensor.sensor == 'disabled') {
			return;
		}
		scripts[id].sensors[idx] = sensor.sensor;
		scripts[id].config.sensors[idx]['status'] = -1;
	});

	defineRule(id + ".sensor-rule", {
		whenChanged: scripts[id].sensors,
		then: function (value, devName, cellName) {
			motionLogic(id)
		}
	});

	defineRule(id + ".on-off-rule", {
		whenChanged: enable,
		then: function (value, devName, cellName) {
			scripts[id].state = (value === true) ? 'clear' : 'off';
			publish(topic + 'state', scripts[id].state, 0, true);
			motionLogic(id)
		}
	});

	motionLogic(id);
}
