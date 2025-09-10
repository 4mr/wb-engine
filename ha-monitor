#!/usr/bin/env python3

import subprocess
import sys
import os
import logging
import signal
import traceback
import paho.mqtt.client as mqtt

TOPIC_NAME = os.getenv("HA_TOPIC_NAME", "homeassistant/status")
BROKER_IP = os.getenv("BROKER_IP", "localhost")
BROKER_PORT = int(os.getenv("BROKER_PORT", "1883"))

# setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)

logger = logging.getLogger(__name__)


class SimpleHAStatusMonitor:
    """
    Monitor Home Assistant status via MQTT.
    """

    def __init__(
        self,
        broker=BROKER_IP,
        port=BROKER_PORT,
    ):
        logger.debug("BROKER_IP %s", broker)
        logger.debug("BROKER_PORT %s", port)
        self.broker = broker
        self.port = port
        self.current_status = None
        self.previous_status = None

    def on_connect(
        self,
        client,
        userdata,
        flags,
        rc,
    ):
        if rc == 0:
            result = client.subscribe(TOPIC_NAME)
            if result[0] == 0:
                logger.info("Subscribed to %s topic", TOPIC_NAME)
            else:
                logger.error("Failed subscribe to %s topic", TOPIC_NAME)
        else:
            logger.error(
                "Connection error: %s - %s",
                rc,
                mqtt.error_string(rc),
            )

    def on_message(
        self,
        client,
        userdata,
        msg,
    ):
        """
        Checking status On message in topic
        :param client:
        :param userdata:
        :param msg:
        :return:
        """
        if msg.topic == TOPIC_NAME:
            new_status = msg.payload.decode().strip().lower()
            # Save prev status
            self.previous_status = self.current_status
            self.current_status = new_status
            logger.info("Status: %s", new_status)
            # Check status "online"
            if (not self.previous_status and self.current_status == "online") or (
                self.previous_status == "offline" and self.current_status == "online"
            ):
                self.wb_engine_start()

    def on_disconnect(self, client, userdata, rc):
        """
        Disconnect callback
        :param client:
        :param userdata:
        :param rc:
        :return:
        """
        logger.error("Connection lost")

    def wb_engine_start(self):
        """
        Start wb-engine-helper --start
        :return:
        """
        try:
            logger.info("Try to start wb-engine-helper...")
            res = subprocess.run(
                ["wb-engine-helper", "--start"],
                capture_output=True,
                text=True,
                check=False,
            )
            if res.returncode != 0:
                logger.error("wb-engine-helper failed with code %s", res.returncode)
                logger.error("stderr: %s", res.stderr)
            elif res.stdout.strip():
                logger.info(res.stdout)
            else:
                logger.info("wb-engine-helper started OK")
        except Exception as e:
            logger.error("Unexpected error: %s", e)

    def start(self):
        """
        Main function in class
        :return:
        """
        client = mqtt.Client()
        client.on_connect = self.on_connect
        client.on_message = self.on_message
        client.on_disconnect = self.on_disconnect
        try:
            client.connect(self.broker, self.port, 60)
            client.reconnect_delay_set(min_delay=1, max_delay=30)
            client.loop_forever()
        except Exception as e:
            logger.error("Error: %s", e)
            exc_type, exc_val, exc_tb = sys.exc_info()
            logger.error(traceback.print_exception(exc_type, exc_val, exc_tb))

    def signal_exit(self, signum, frame):
        """
        System event listner: SIGTERM, SIGINT
        :param signum:
        :param frame:
        :return:
        """
        sys.exit(0)


# Starting monitoring
if __name__ == "__main__":
    monitor = SimpleHAStatusMonitor()
    signal.signal(signal.SIGINT, monitor.signal_exit)
    signal.signal(signal.SIGTERM, monitor.signal_exit)
    monitor.start()
