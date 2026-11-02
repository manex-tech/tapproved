#include "amount_format.h"

#include <cassert>
#include <cstring>

int main() {
  char output[64];

  assert(formatYoctoNear("1", output, sizeof(output)));
  assert(std::strcmp(output, "0.000000000000000000000001 NEAR") == 0);

  assert(formatYoctoNear("1000000000000000000000", output, sizeof(output)));
  assert(std::strcmp(output, "0.001 NEAR") == 0);

  assert(formatYoctoNear("1000000000000000000000000", output, sizeof(output)));
  assert(std::strcmp(output, "1 NEAR") == 0);

  assert(formatYoctoNear("1234567890123456789012345", output, sizeof(output)));
  assert(std::strcmp(output, "1.234567890123456789012345 NEAR") == 0);

  assert(!formatYoctoNear("01", output, sizeof(output)));
  assert(!formatYoctoNear("1x", output, sizeof(output)));
  assert(!formatYoctoNear("340282366920938463463374607431768211456", output, sizeof(output)));
  assert(!formatYoctoNear("1", output, 4));

  return 0;
}
