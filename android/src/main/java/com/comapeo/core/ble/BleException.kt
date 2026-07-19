package com.comapeo.core.ble

import expo.modules.kotlin.exception.CodedException

/**
 * Rejection surfaced to JS with a stable machine-readable `code`
 * (Expo maps it onto the rejected promise). Codes used:
 *
 * - `ERR_BLE_UNAVAILABLE` — no Bluetooth adapter on this device
 * - `ERR_BLE_DISABLED` — Bluetooth is switched off
 * - `ERR_BLE_ADVERTISE_UNSUPPORTED` — chipset can't do LE advertising
 * - `ERR_BLE_SCAN_UNSUPPORTED` — no LE scanner (adapter off races here too)
 * - `ERR_BLE_PERMISSION` — a required runtime permission is missing
 * - `ERR_BLE_PAYLOAD` — invalid/oversized payload from JS
 * - `ERR_BLE_CONTEXT` — called before the react context attached
 *
 * Async post-start failures use the same codes on the `bleError` event
 * (plus `ERR_BLE_ADVERTISE` / `ERR_BLE_SCAN` for OS callback errors).
 */
class BleException(code: String, message: String) :
    CodedException(code, message, null)
