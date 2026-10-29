idf_component_register(SRCS "main.c" "board.c" "button_gesture.c" "capture_context.c" "storage.c" "recorder.c" "pcm_fifo.c" "ble.c" "control.c" "wifi.c" "wire.c" "metadata_index.c"
    INCLUDE_DIRS "."
    REQUIRES bt nvs_flash driver esp_app_format esp_driver_i2c esp_driver_i2s esp_driver_gpio esp_timer
             fatfs sdmmc esp_wifi esp_netif esp_http_server mbedtls json esp_hw_support)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror=implicit-function-declaration)
# The HTTP worker has an 8 KiB stack shared with SDK/parser/filesystem calls.
# Keep application frames below 3 KiB; bulk buffers belong in bounded PSRAM.
set_source_files_properties("wifi.c" "storage.c" "control.c" "recorder.c" "ble.c" "main.c" "wire.c" "metadata_index.c"
    PROPERTIES COMPILE_OPTIONS "-Werror=frame-larger-than=3072")
# The dedicated 8 KiB PCM task owns a 4 KiB TDM input frame plus its caller.
set_source_files_properties("board.c" PROPERTIES COMPILE_OPTIONS "-Werror=frame-larger-than=5120")
