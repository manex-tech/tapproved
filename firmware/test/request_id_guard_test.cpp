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
  return 0;
}
