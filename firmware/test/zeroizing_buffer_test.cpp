#include "zeroizing_buffer.h"

#include <cassert>
#include <cstdint>

int main() {
  ZeroizingBuffer<64> buffer;
  assert(buffer.size() == 64);
  for (size_t i = 0; i < buffer.size(); ++i) {
    buffer.data()[i] = static_cast<uint8_t>(i + 1);
  }
  buffer.clear();
  for (size_t i = 0; i < buffer.size(); ++i) {
    assert(buffer.data()[i] == 0);
  }

  ZeroizingBuffer<1> single_byte;
  single_byte.data()[0] = 0xA5;
  single_byte.clear();
  assert(single_byte.data()[0] == 0);
  return 0;
}
