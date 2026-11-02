#pragma once

#include <cstddef>
#include <cstdint>

template <size_t Size>
class ZeroizingBuffer {
 public:
  ZeroizingBuffer() = default;
  ZeroizingBuffer(const ZeroizingBuffer&) = delete;
  ZeroizingBuffer& operator=(const ZeroizingBuffer&) = delete;

  ~ZeroizingBuffer() { clear(); }

  uint8_t* data() { return bytes_; }
  const uint8_t* data() const { return bytes_; }
  constexpr size_t size() const { return Size; }

  void clear() {
    volatile uint8_t* destination = bytes_;
    for (size_t i = 0; i < Size; ++i) {
      destination[i] = 0;
    }
  }

 private:
  uint8_t bytes_[Size] = {};
};
