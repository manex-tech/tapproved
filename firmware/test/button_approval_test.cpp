#include "button_approval.h"

#include <cassert>
#include <cstdint>

int main() {
  // A button held when a request arrives must be released to arm, then
  // pressed and released again before approval is possible.
  FreshPressDetector held_at_arrival(50);
  held_at_arrival.begin(false, 0);
  held_at_arrival.update(false, 100);
  assert(!held_at_arrival.armed());
  held_at_arrival.update(true, 110);
  assert(!held_at_arrival.update(true, 160));
  assert(held_at_arrival.armed());
  held_at_arrival.update(false, 170);
  assert(!held_at_arrival.update(false, 220));
  held_at_arrival.update(true, 230);
  assert(held_at_arrival.update(true, 280));
  assert(held_at_arrival.approved());

  // A short press that does not survive the debounce interval is ignored.
  FreshPressDetector short_press(50);
  short_press.begin(true, 0);
  short_press.update(true, 50);
  assert(short_press.armed());
  short_press.update(false, 100);
  short_press.update(true, 120);
  assert(!short_press.update(true, 170));
  assert(!short_press.sawPress());
  assert(!short_press.approved());

  // Contact bounce does not count; a later stable press/release does.
  FreshPressDetector bouncing(50);
  bouncing.begin(true, 0);
  bouncing.update(true, 50);
  bouncing.update(false, 100);
  bouncing.update(true, 120);
  assert(!bouncing.update(true, 170));
  bouncing.update(false, 200);
  assert(!bouncing.update(false, 250));
  bouncing.update(true, 260);
  assert(bouncing.update(true, 310));

  // A stable release at startup arms the device, but no press means no approval.
  FreshPressDetector timeout(50);
  timeout.begin(true, 0);
  timeout.update(true, 50);
  assert(timeout.armed());
  assert(!timeout.approved());

  // Unsigned elapsed-time arithmetic remains correct across millis() rollover.
  FreshPressDetector rollover(50);
  rollover.begin(true, UINT32_MAX - 20U);
  assert(!rollover.update(true, 29U));
  assert(rollover.armed());

  return 0;
}
