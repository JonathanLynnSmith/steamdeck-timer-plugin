# ────────────────────────────────────────────────
# Stream Deck Plugin Build Script (Windows)
# ────────────────────────────────────────────────

PLUGIN_NAME := TimerPlugin
PLUGIN_FOLDER := com.jonsmith.timer.sdPlugin
BUILD_ZIP := $(PLUGIN_NAME).zip
BUILD_PLUGIN := $(PLUGIN_NAME).streamDeckPlugin

all: build

build:
	@echo "Building $(BUILD_PLUGIN)..."
	@powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '$(BUILD_ZIP)') { Remove-Item -Force '$(BUILD_ZIP)' }; Compress-Archive -LiteralPath '$(PLUGIN_FOLDER)' -DestinationPath '$(BUILD_ZIP)' -Force"
	@powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '$(BUILD_PLUGIN)') { Remove-Item -Force '$(BUILD_PLUGIN)' }; Copy-Item -Force '$(BUILD_ZIP)' '$(BUILD_PLUGIN)'"
	@echo "Build complete: $(BUILD_PLUGIN)"

clean:
	@echo "Cleaning..."
	@powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path '$(BUILD_ZIP)') { Remove-Item -Force '$(BUILD_ZIP)' }; if (Test-Path '$(BUILD_PLUGIN)') { Remove-Item -Force '$(BUILD_PLUGIN)' }"
	@powershell -NoProfile -ExecutionPolicy Bypass -Command "$$pluginPath = Join-Path $$env:APPDATA 'Elgato\StreamDeck\Plugins\com.jonsmith.timer.sdPlugin'; if (Test-Path $$pluginPath) { Remove-Item -Recurse -Force $$pluginPath }"
	@echo "Clean complete"

rebuild:
	@make clean
	@make build
