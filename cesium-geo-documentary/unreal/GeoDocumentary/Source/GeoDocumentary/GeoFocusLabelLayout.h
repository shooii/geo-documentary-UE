#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>

// 无引擎依赖：原生 HUD 和独立回归测试共用同一套屏幕布局。
namespace GeoFocusLabel
{
struct Point { double X, Y; };
struct Rect { double Left, Top, Right, Bottom; };
struct Placement
{
    Rect Bounds{};
    int Candidate = -1;
    bool Valid = false;
};
inline double Clearance(const Rect& Box, const Rect& Safe, const Rect* Obstacles, std::size_t Count)
{
    double Value = std::min(std::min(Box.Left - Safe.Left, Safe.Right - Box.Right),
                            std::min(Box.Top - Safe.Top, Safe.Bottom - Box.Bottom));
    for (std::size_t I = 0; I < Count; ++I)
    {
        const Rect& Other = Obstacles[I];
        Value = std::min(Value, std::max(std::max(Other.Left - Box.Right, Box.Left - Other.Right),
                                        std::max(Other.Top - Box.Bottom, Box.Top - Other.Bottom)));
    }
    return Value;
}
struct Badge
{
    Point Half;
    double IconSize, TextOffset;
};
inline Badge WithIcon(Point TextHalf, double IconSize, double Gap)
{
    const double Extra = IconSize + Gap;
    return {{TextHalf.X + Extra * .5, std::max(TextHalf.Y, IconSize * .5)}, IconSize, Extra * .5};
}
inline Placement Place(const Rect& Original, Point Half, const Rect& Safe,
                       const Rect* Obstacles, std::size_t Count, double Margin)
{
    if (Clearance(Original, Safe, Obstacles, Count) >= Margin)
        return {Original, 0, true};
    // 固定画幅格位、固定顺序，不以浮动距离排名；播放、倒放与随机采样结果一致。
    const double Left = Safe.Left + Half.X + Margin, Right = Safe.Right - Half.X - Margin;
    const double Top = Safe.Top + Half.Y + Margin, Bottom = Safe.Bottom - Half.Y - Margin;
    if (Left > Right || Top > Bottom)
        return {};
    const double X[] = {(Left + Right) * .5, Left, Right};
    const double Y[] = {Top, Top + (Bottom - Top) * .25, (Top + Bottom) * .5,
                        Top + (Bottom - Top) * .75, Bottom};
    int Candidate = 1;
    for (double Cy : Y)
        for (double Cx : X)
        {
            const Rect Box{Cx - Half.X, Cy - Half.Y, Cx + Half.X, Cy + Half.Y};
            if (Clearance(Box, Safe, Obstacles, Count) >= Margin - 1e-6)
                return {Box, Candidate, true};
            ++Candidate;
        }
    return {};
}
inline Point Nearest(const Rect& Box, Point P)
{
    return {std::max(Box.Left, std::min(Box.Right, P.X)),
            std::max(Box.Top, std::min(Box.Bottom, P.Y))};
}
// 引线从名牌边缘向地理锚点延伸，遇字幕/其他已占区域即停，绝不穿过字幕。
inline Point ClipLeader(Point Start, Point End, const Rect* Obstacles, std::size_t Count, double Gap)
{
    const double Dx = End.X - Start.X, Dy = End.Y - Start.Y;
    double Stop = 1;
    for (std::size_t I = 0; I < Count; ++I)
    {
        const Rect R{Obstacles[I].Left - Gap, Obstacles[I].Top - Gap,
                     Obstacles[I].Right + Gap, Obstacles[I].Bottom + Gap};
        double Enter = 0, Exit = 1;
        const auto Axis = [&](double S, double D, double Lo, double Hi) {
            if (std::abs(D) < 1e-9) return S >= Lo && S <= Hi;
            double A = (Lo - S) / D, B = (Hi - S) / D;
            if (A > B) std::swap(A, B);
            Enter = std::max(Enter, A); Exit = std::min(Exit, B);
            return Enter <= Exit;
        };
        if (Axis(Start.X, Dx, R.Left, R.Right) && Axis(Start.Y, Dy, R.Top, R.Bottom))
            Stop = std::min(Stop, std::max(0., Enter));
    }
    return {Start.X + Dx * Stop, Start.Y + Dy * Stop};
}
}
