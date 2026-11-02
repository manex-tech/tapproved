#include "request_id_guard.h"

#include <cassert>

int main() {
  LastRequestIdGuard guard;
  const char* first = "123e4567-e89b-42d3-a456-426614174000";
  const char* second = "123e4567-e89b-42d3-a456-426614174001";
  assert(guard.accept(first));
  assert(!guard.accept(first));
  assert(guard.accept(second));
  assert(!guard.accept(second));
  assert(!guard.accept(first));
  assert(!guard.accept("short"));

  // The replay window is deliberately volatile. A new guard models a device
  // reboot: the same transport ID can be seen again, while contract payment
  // state and canonical signature checks remain the durable replay authority.
  LastRequestIdGuard after_reset;
  assert(after_reset.accept(first));
  assert(!after_reset.accept(first));
  return 0;
}
