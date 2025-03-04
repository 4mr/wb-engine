exports.init = engineInit;

var config = {};
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
	try {
		config = readConfig("/etc/wb-rules/wb-engine.conf");
	} catch (e) {
		// NOTE: readConfig already logging it's error
	}

	runShellCommand("/usr/bin/wb-engine-helper --start", {
		captureOutput: true,
		captureErrorOutput: true,
		exitCallback: function(exitCode, out, err) {
			if (out != "") {
				log(out);
			}
			if (err != "") {
				log(err);
			}
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
			case 'cover':
				scriptCoverInit(script);
				break;
		}
	});
}

function termosatLogic(id, stateChanged) {
	var topic = '/devices/' + id + '/controls/';
	var temps = [];
	var relays = 0;
	var inverted = scripts[id].inverted;

	if (typeof stateChanged === "undefined") {
		stateChanged = false;
	}

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

		if (!(scripts[id].state == 'off' && stateChanged == false)) {
			dev[zone.relay] = relay;
			publish(topic + relay_status, (relay) ? 1 : 0, 0, true);
		}

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

	trackMqtt('/devices/' + id + '/controls/mode/set', function(msg){
		if (msg.value == 'off') {
			scripts[id].state = 'off';
			publish(topic + 'enable', 0, 0, true);
		} else {
			scripts[id].state = 'idle';
			publish(topic + 'enable', 1, 0, true);
		}
		termosatLogic(id, true)
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
			termosatLogic(id, true)
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

function scriptCoverInit(script) {
	var id = "script_" + script['name'].fix();

	log('scriptCoverInit[{}]', id);

	if (typeof scripts[id] == 'undefined') {
		defineVirtualDevice(id, {
			title: script.title,
			cells: {
				state: {
					title: "State",
					type: "text",
					value: "stopped",
					order: 1
				},
				position: {
					title: "Position",
					type: "range",
					order: 2,
					value: 0,
					max: 100,
				},
				open: {
					title: "Open",
					type: "pushbutton",
					order: 3
				},
				stop: {
					title: "Stop",
					type: "pushbutton",
					order: 4
				},
				close: {
					title: "Close",
					type: "pushbutton",
					order: 5
				}
			}
		});

		scripts[id] = {
			state: 'off',
			sensors: [],
			run_time: script.run_time,
			config: script,
			timer: false,
			timer2: false,
			currentPosition: dev[id]['position'] || 0,
			startTime: false,
			doOpen: false
		}

		log('scriptCoverInit[{}] currentPosition = {}', id, scripts[id].currentPosition);
	}

	trackMqtt('/devices/' + id + '/command', function(msg){
		coverLogic(id, msg.value.toLowerCase());
	});

	trackMqtt('/devices/' + id + '/controls/position/on', function(msg){
		var position = parseInt(msg.value.toLowerCase(), 10);
		if (isNaN(position) || position < 0 || position > 100) {
			log("{}: invalid position command: {}", id, cmd);
			return;
		}
		coverLogic(id, position);
	});

	defineRule(id + '.open', {
		whenChanged: id + '/open',
		then: function (value, devName, cellName) {
			coverLogic(id, 'open');
		}
	});

	defineRule(id + '.stop', {
		whenChanged: id + '/stop',
		then: function (value, devName, cellName) {
			coverLogic(id, 'stop');
		}
	});

	defineRule(id + '.close', {
		whenChanged: id + '/close',
		then: function (value, devName, cellName) {
			coverLogic(id, 'close');
		}
	});

}

function coverLogic(id, cmd) {
	var run_time = scripts[id].run_time;
	var relay = scripts[id].config.relay;
	var relay_direction = scripts[id].config.relay_direction;
	var topic = '/devices/' + id + '/state';

	if (relay == "" || relay_direction == "") {
		log('{} relay or relay_direction not defined', id);
		return;
	}

	log('{} cmd {}', id, cmd);
	var currentPosition = scripts[id].currentPosition; // Текущее положение (в процентах)

	if (scripts[id].timer) {
		clearTimeout(scripts[id].timer);
		scripts[id].timer == false;
	}
	if (scripts[id].timer2) {
		clearTimeout(scripts[id].timer2);
		scripts[id].timer2 = false;
	}
	if (scripts[id].timer3) {
		clearTimeout(scripts[id].timer3);
		scripts[id].timer3 = false;

		// Обновление текущего положения
		var elapsedTime = (Date.now() - scripts[id].startTime) / 1000;
		var deltaPosition = (elapsedTime / run_time) * 100;

		if (scripts[id].doOpen) {
			currentPosition = Math.min(100, currentPosition + deltaPosition);
		} else {
			currentPosition = Math.max(0, currentPosition - deltaPosition);
		}
		currentPosition = Math.round(currentPosition);
		scripts[id].currentPosition = currentPosition;
		log('{} position updated to {}%', id, currentPosition);
	}

	if (cmd == 'stop') {
		dev[relay] = false;
		dev[id]['state'] = 'stopped';
		dev[id]['position'] = currentPosition;
		return;
	}

	// Получение целевой позиции
	var targetPosition = typeof cmd === 'number' ? cmd : (cmd === 'open' ? 100 : 0);

	if (targetPosition === currentPosition) {
		log('{} already at target position: {}%', id, currentPosition);
		return;
	}

	var isOpen = targetPosition > currentPosition; // true - вверх, false - вниз
	var delay = dev[relay] ? 500 : 50; // Задержка перед переключением реле

	var movementTime = Math.abs(targetPosition - currentPosition) / 100 * run_time; // время движения в секундах

	if (targetPosition == 0 || targetPosition == 100) {
		movementTime = run_time
	}

	log('{} do {}, delay = {}, position = {} -> {}, movement = {} sec', id, isOpen ? 'open' : 'close', delay, currentPosition, targetPosition, movementTime.toFixed(2));
	dev[relay] = false;

	scripts[id].timer = setTimeout(function(){
		scripts[id].timer = false;

		log('{} do {} set position {}', id, isOpen ? 'open' : 'close', targetPosition)
		dev[relay_direction] = isOpen;
		scripts[id].doOpen = isOpen;

		scripts[id].timer2 = setTimeout(function(){
			scripts[id].timer2 = false;

			dev[relay] = true;
			dev[id]['state'] = isOpen ? 'opening' : 'closing';

			scripts[id].startTime = Date.now();

			scripts[id].timer3 = setTimeout(function(){
				scripts[id].timer3 = false;

				log('{} relay off', id);
				dev[relay] = false;
				dev[id]['state'] = 'stopped';

				if (targetPosition == 100) {
					dev[id]['state'] = 'open';
				} else if (targetPosition == 0) {
					dev[id]['state'] = 'closed';
				}

				// Синхронизация позиции
				scripts[id].currentPosition = targetPosition;
				dev[id]['position'] = targetPosition;
				log('{} position updated to {}%', id, targetPosition);
			}, movementTime * 1000);
		}, 100);
	}, delay);
}
