// Runs in the page's own world, in every frame: the only place to see a page
// turn on the microphone or camera, as a call does. It tells relay.ts, which
// tells the background, so search can put calls first. It wraps getUserMedia
// only to watch the tracks it hands out, and learns nothing of what's in them.
// Chrome only; the Firefox build leaves it out.

// A type only: nothing from the extension may be bundled into the page's world.
import type { MediaSignal } from "../shared/messages";

(() => {
	const proto = globalThis.MediaDevices?.prototype;
	if (!proto?.getUserMedia) return;

	const live = new Set<MediaStreamTrack>(); // microphone and camera tracks still running
	let was = false;

	function tell() {
		const now = live.size > 0;
		if (now === was) return;
		was = now;
		postMessage({ tabstack: "media", live: now } satisfies MediaSignal, "*");
	}

	function end(track: MediaStreamTrack) {
		live.delete(track);
		tell();
	}

	const getUserMedia = proto.getUserMedia;
	proto.getUserMedia = async function (...args) {
		const stream = await getUserMedia.apply(this, args);
		for (const track of stream.getTracks()) {
			if (track.readyState !== "live") continue;
			live.add(track);
			track.addEventListener("ended", () => end(track));
		}
		tell();
		return stream;
	};

	// A page ending its call stops the tracks itself, which doesn't fire "ended".
	const stop = MediaStreamTrack.prototype.stop;
	MediaStreamTrack.prototype.stop = function () {
		stop.call(this);
		if (live.has(this)) end(this);
	};

	// leaving the page, or the frame going away, ends its call
	addEventListener("pagehide", () => {
		live.clear();
		tell();
	});
})();
