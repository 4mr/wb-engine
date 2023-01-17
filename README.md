# WirenBoard Engine

Скрипт создан для добавления виртуальных устройств в WirenBoard без написания кода в wb-rules, а также добавления устройств в Home Assistant.

## Пример настройки

<p align="center">
  <img src="docs/images/configs.png">
  <img src="docs/images/wb-engine1.png">
  <img src="docs/images/wb-engine2.png">
</p>

## Пример созданого виртуального термостата

<p align="center">
  <img src="docs/images/wb-engine3.png" width="45%">
  <img src="docs/images/ha1.png" width="45%">
</p>

## Установка

Скачайте файл пакета на устройство WirenBoard и установите с помощью dpkg.

```
wget https://github.com/4mr/wb-engine/releases/download/v0.2.19/wb-engine_0.2.19_armhf.deb
dpkg -i wb-engine_0.2.19_armhf.deb
```
