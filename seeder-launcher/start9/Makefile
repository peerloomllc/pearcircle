# Build the PearCircle seeder .s9pk for StartOS 0.3.5.x.
#
#   make            build + verify the s9pk (x86_64)
#   make install    install to the server in ~/.embassy/config.yaml
#   make clean       remove build artifacts
#
# Requires: deno, yq, the StartOS SDK (start-sdk / start-cli), and either
# docker (buildx) OR podman + skopeo. See scripts/build-image-tar.sh.

PKG_ID := $(shell yq e ".id" < manifest.yaml)
PKG_VERSION := $(shell yq e ".version" < manifest.yaml)
TS_FILES := $(shell find ./scripts -name \*.ts)

# delete a rule's target if its recipe fails partway
.DELETE_ON_ERROR:

all: verify

verify: $(PKG_ID).s9pk
	@start-sdk verify s9pk $(PKG_ID).s9pk
	@echo " Done!"
	@echo "   $(shell du -h $(PKG_ID).s9pk) is ready"

install:
	@if [ ! -f ~/.embassy/config.yaml ]; then \
		echo 'Define  host: https://<server>.local  in ~/.embassy/config.yaml first.'; exit 1; fi
	@echo "\nInstalling to $$(grep -v '^#' ~/.embassy/config.yaml | cut -d'/' -f3) ...\n"
	@[ -f $(PKG_ID).s9pk ] || $(MAKE)
	@start-cli package install $(PKG_ID).s9pk

clean:
	rm -rf docker-images
	rm -f $(PKG_ID).s9pk
	rm -f scripts/embassy.js

# Bundle the TS procedures (health, config, migrations, properties) into the
# single embassy.js the s9pk loads.
scripts/embassy.js: $(TS_FILES)
	deno run --allow-read --allow-write --allow-env --allow-net scripts/bundle.ts

# Build the runtime image for amd64 and export it as a docker-archive tar the
# packer loads, tagged start9/<id>/main:<version>. Uses docker if present, else
# podman + a RepoTags normalization (see scripts/build-image-tar.sh).
docker-images/x86_64.tar: Dockerfile docker_entrypoint.sh scripts/build-image-tar.sh
	bash scripts/build-image-tar.sh $(PKG_ID) $(PKG_VERSION) docker-images/x86_64.tar

$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar
	@echo "start-sdk: packing $(PKG_ID) v$(PKG_VERSION) ..."
	@start-sdk pack
