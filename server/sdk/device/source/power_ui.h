#pragma once
#include "fullscreen_page.h"
#include <cstdint>
#include <cstdio>

namespace Tamagotchi::PowerUi {
struct Settings { bool rational=true;uint8_t brightness=100;bool glance=false;bool alwaysScreen=false; };
inline bool valid(const Settings& settings) {
  return settings.brightness>=25 && settings.brightness<=100 && settings.brightness%25==0;
}
// One versioned NVS word, with reserved bits rejected rather than reinterpreted
// as future settings. Invalid storage leaves the caller's defaults untouched.
inline uint32_t encode(const Settings& settings) {
  if(!valid(settings)) return 0;
  return 0x4b501000u | (uint32_t(settings.brightness/25-1)<<6) |
      uint32_t(settings.rational) | (uint32_t(settings.glance)<<1) | (uint32_t(settings.alwaysScreen)<<2);
}
inline bool decode(uint32_t word,Settings& settings) {
  if((word&~uint32_t(0xc7))!=0x4b501000u) return false;
  settings={bool(word&1),uint8_t((((word>>6)&3)+1)*25),bool(word&2),bool(word&4)};
  return true;
}
enum class Input { Down,Move,Up,Cancel };
struct Layout { int left=0,top=0,width=0,rowHeight=0,stride=0; };
inline Layout layout(int width,int height) {
  if(width<240 || height<280) return {};
  const auto page=PageUi::layout(width,height,"Power");
  const int available=(page.bodyBottom-page.bodyTop-18)/4;
  const int rowHeight=available>44?44:available;
  if(rowHeight<36) return {};
  return {12,page.bodyTop,width-24,rowHeight,rowHeight+6};
}
class View {
 public:
  void open(const Settings& settings=Settings{}) {
    settings_=valid(settings)?settings:Settings{};
    visible_=true;
    gesture_.cancel();
  }
  void close() { visible_=false;gesture_.cancel(); }
  bool active() const { return visible_; }
  bool visible() const { return visible_; }
  const Settings& settings() const { return settings_; }
  int pressedTarget() const { return gesture_.pressedTarget(); }
  void cancelTouch() { gesture_.cancel(); }
  int hit(int x,int y,int width,int height) const {
    if(!visible_) return -1;
    const auto rows=layout(width,height);
    if(!rows.rowHeight) return -1;
    for(int row=0;row<4;++row)
      if(Ui::roundedPixel(x-rows.left,y-(rows.top+row*rows.stride),rows.width,rows.rowHeight,10)) return row;
    return PageUi::backHit(x,y,width,height)?4:-1;
  }
  bool input(Input kind,int x,int y,int width,int height) {
    if(!visible_) return false;
    const int target=hit(x,y,width,height);
    switch(kind) {
      case Input::Down:gesture_.begin(x,y,target);return false;
      case Input::Move:gesture_.move(x,y);return false;
      case Input::Cancel:gesture_.cancel();return false;
      case Input::Up:break;
    }
    switch(gesture_.release(x,y,target)) {
      case 0:settings_.rational=!settings_.rational;return true;
      case 1:settings_.brightness=settings_.brightness==100?25:uint8_t(settings_.brightness+25);return true;
      case 2:settings_.glance=!settings_.glance;return true;
      case 3:settings_.alwaysScreen=!settings_.alwaysScreen;return true;
      case 4:close();return false;
      default:return false;
    }
  }
 private:
  Settings settings_;
  TapGesture gesture_;
  bool visible_=false;
};
inline void draw(uint16_t* frame,int width,int height,const View& view) {
  if(!frame || !view.visible()) return;
  const auto rows=layout(width,height);
  if(!rows.rowHeight) return;
  PageUi::drawShell(frame,width,height,"Power",view.pressedTarget()==4);
  static constexpr const char* labels[4]={"Power saver","Brightness","10 min glance","Always on"};
  const auto& settings=view.settings();
  char brightness[5];
  std::snprintf(brightness,sizeof brightness,"%u%%",unsigned(settings.brightness));
  const char* values[4]={settings.rational?"ON":"OFF",brightness,
      settings.glance?"ON":"OFF",settings.alwaysScreen?"ON":"OFF"};
  for(int row=0;row<4;++row) {
    const int top=rows.top+row*rows.stride,bottom=top+rows.rowHeight;
    Ui::box(frame,width,height,rows.left,top,rows.width,rows.rowHeight,10,view.pressedTarget()==row,top);
    const int labelTop=Ui::centeredTextTop(labels[row],top,rows.rowHeight);
    Ui::text(frame,width,height,labels[row],rows.left+10,labelTop,2,theme().text,top,bottom);
    Ui::text(frame,width,height,values[row],rows.left+rows.width-10-Ui::textWidth(values[row]),
        Ui::centeredTextTop(values[row],top,rows.rowHeight),2,theme().text,top,bottom);
  }
}
} // namespace Tamagotchi::PowerUi
