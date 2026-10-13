import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="min-h-[80vh] w-full flex items-center justify-center">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <h1 className="text-2xl font-bold text-foreground">Страница не найдена</h1>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Похоже, вы перешли по неверной ссылке. Пожалуйста, вернитесь на главную страницу или воспользуйтесь меню.
          </p>
          <div className="mt-8 flex justify-center">
            <Link href="/">
              <Button variant="default" className="w-full sm:w-auto">
                Вернуться на главную
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
